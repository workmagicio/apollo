/*
 * Copyright 2024 Apollo Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */
/**
 * Visual editor for a JSON value keyed by tenant id, in one of two shapes:
 *   'flags': {"6": {"showCustomDashboard": true}, "45": {"showChannelInsights": true}}
 *   'list':  {"133277": ["microsoft", "google"], "150198": ["google"]}
 * Every change is serialized back into `value`, so the surrounding form submits as usual.
 */
directive_module.directive('jsonflageditor', jsonFlagEditorDirective);

/**
 * Which shape the visual editor can edit a parsed JSON value as, or null if neither:
 * 'flags' when every entry is an object of primitive values,
 * 'list' when every entry is an array of strings. An empty object counts as 'flags'.
 */
function jsonFlagMapKind(value) {
    if (!JsonStrictParser.isPlainObject(value)) {
        return null;
    }
    var ids = Object.keys(value);
    var isFlags = ids.every(function (id) {
        var flags = value[id];
        return JsonStrictParser.isPlainObject(flags) && Object.keys(flags).every(function (name) {
            return flags[name] === null || typeof flags[name] !== 'object';
        });
    });
    if (isFlags) {
        return 'flags';
    }
    var isList = ids.every(function (id) {
        return Array.isArray(value[id]) && value[id].every(function (item) {
            return typeof item === 'string';
        });
    });
    return isList ? 'list' : null;
}

/**
 * Reads a config value the way the visual editor does (duplicate keys merged) as
 * {kind, value, duplicates}, or null when the editor cannot take it: not one of the two shapes,
 * or holding numbers it would not write back unchanged.
 */
function jsonFlagMapParse(text) {
    var parsed = JsonStrictParser.parse(text || '', {mergeDuplicates: true});
    var kind = parsed.ok && parsed.exactNumbers && jsonFlagMapKind(parsed.value);
    return kind ? {kind: kind, value: parsed.value, duplicates: parsed.duplicates} : null;
}

function jsonFlagEditorDirective($translate, $timeout, toastr, AppUtil) {
    return {
        restrict: 'E',
        templateUrl: AppUtil.prefixPath() + '/views/component/json-flag-editor.html',
        replace: true,
        scope: {
            value: '=',
            baseline: '=',
            onChange: '&'
        },
        link: function (scope, element) {

            var FLAG_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

            // {id: entry}: a 'flags' entry is {name: value}, a 'list' entry stays an array so its
            // order is kept; its items read as flags set to true. Maps have no prototype, so
            // "__proto__" is an ordinary tenant id or flag name.
            var kind = 'flags';
            var data = Object.create(null);
            var baselineData = Object.create(null);
            var indent = 4;

            scope.unsupported = false;
            scope.isList = false;
            scope.filter = {text: '', flag: ''};
            scope.newTenant = {id: ''};
            scope.rows = [];
            scope.knownFlags = [];
            scope.changes = [];
            scope.mergedDuplicates = [];
            scope.dedupedItems = [];
            scope.highlightId = null;

            scope.matchesFilter = matchesFilter;
            scope.toggleFlag = toggleFlag;
            scope.removeFlag = removeFlag;
            scope.addFlag = addFlag;
            scope.addTenant = addTenant;
            scope.removeTenant = removeTenant;
            scope.onAddFlagKeydown = onAddFlagKeydown;
            scope.onAddTenantKeydown = onAddTenantKeydown;
            scope.isBoolean = isBoolean;

            init();

            // Enter inside the item form would submit the whole config item
            element.on('keydown', 'input', function (e) {
                if (e.keyCode === 13) {
                    e.preventDefault();
                }
            });

            // picking a suggestion from the datalist adds the flag right away
            element.on('input', 'input.json-flag-add', function (e) {
                var inputType = e.originalEvent && e.originalEvent.inputType;
                if (inputType && inputType !== 'insertReplacementText') {
                    return;
                }
                var input = $(e.target);
                var flagName = input.val();
                var row = findRow(input.attr('data-row-id'));
                if (row && isKnownFlag(flagName) && !hasFlag(row.id, flagName)) {
                    scope.$apply(function () {
                        addFlag(row, flagName);
                    });
                }
            });

            function init() {
                var source = scope.value || '';
                var parsed = jsonFlagMapParse(source);
                if (!parsed) {
                    // the entry link is only offered for values this editor can take; never rewrite one it cannot
                    scope.unsupported = true;
                    return;
                }
                kind = parsed.kind;
                scope.isList = kind === 'list';
                data = toEditShape(parsed.value, scope.dedupedItems);

                var baselineParsed = JsonStrictParser.parse(scope.baseline || '');
                baselineData = baselineParsed.ok && jsonFlagMapKind(baselineParsed.value) === kind
                    ? toEditShape(baselineParsed.value, []) : Object.create(null);

                var indentMatch = /\n([ \t]+)\S/.exec(source);
                indent = indentMatch ? indentMatch[1] : (source.trim().indexOf('\n') < 0 ? 0 : 4);

                scope.mergedDuplicates = parsed.duplicates.map(function (duplicate) {
                    return {
                        key: duplicate.path.concat([duplicate.key]).join(' › '),
                        lines: duplicate.lines.join(', ')
                    };
                });

                refresh();
                if (scope.mergedDuplicates.length || scope.dedupedItems.length) {
                    // merging duplicates is itself a change the user has to submit
                    writeBack();
                }
            }

            // dedupedItems collects list items that appeared more than once in the same entry;
            // only the first of them is kept, where it was
            function toEditShape(value, dedupedItems) {
                var shaped = Object.create(null);
                Object.keys(value).forEach(function (id) {
                    if (kind === 'list') {
                        var counts = Object.create(null);
                        shaped[id] = value[id].filter(function (item) {
                            counts[item] = (counts[item] || 0) + 1;
                            return counts[item] === 1;
                        });
                        shaped[id].forEach(function (item) {
                            if (counts[item] > 1) {
                                dedupedItems.push({id: id, value: item, count: counts[item]});
                            }
                        });
                        return;
                    }
                    var flags = Object.create(null);
                    Object.keys(value[id]).forEach(function (name) {
                        flags[name] = value[id][name];
                    });
                    shaped[id] = flags;
                });
                return shaped;
            }

            function refresh() {
                scope.rows = Object.keys(data).map(function (id) {
                    return {
                        id: id,
                        flags: flagNames(data[id]).map(function (name) {
                            return {name: name, value: flagValue(data[id], name)};
                        })
                    };
                });
                scope.knownFlags = collectKnownFlags();
                scope.changes = diff(baselineData, data);
            }

            function writeBack() {
                refresh();
                scope.value = JSON.stringify(data, null, indent);
                // let the two-way binding reach the parent before it re-validates
                $timeout(function () {
                    scope.onChange();
                });
            }

            function collectKnownFlags() {
                var counts = Object.create(null);
                [baselineData, data].forEach(function (source) {
                    Object.keys(source).forEach(function (id) {
                        flagNames(source[id]).forEach(function (name) {
                            if (!has(counts, name)) {
                                counts[name] = 0;
                            }
                        });
                    });
                });
                Object.keys(data).forEach(function (id) {
                    flagNames(data[id]).forEach(function (name) {
                        if (flagValue(data[id], name) === true) {
                            counts[name]++;
                        }
                    });
                });
                return Object.keys(counts).sort(function (a, b) {
                    return a.toLowerCase().localeCompare(b.toLowerCase());
                }).map(function (name) {
                    return {name: name, count: counts[name]};
                });
            }

            function matchesFilter(row) {
                var text = (scope.filter.text || '').trim();
                if (text && row.id.indexOf(text) < 0) {
                    return false;
                }
                if (scope.filter.flag && flagValue(data[row.id], scope.filter.flag) !== true) {
                    return false;
                }
                return true;
            }

            function toggleFlag(row, flag) {
                if (kind === 'list' || !isBoolean(flag.value)) {
                    return;
                }
                data[row.id][flag.name] = !flag.value;
                writeBack();
            }

            function removeFlag(row, flag) {
                var entry = data[row.id];
                if (Array.isArray(entry)) {
                    entry.splice(entry.indexOf(flag.name), 1);
                } else {
                    delete entry[flag.name];
                }
                writeBack();
            }

            function addFlag(row, flagName) {
                var name = ((flagName === undefined ? row.newFlag : flagName) || '').trim();
                if (!name) {
                    return;
                }
                var label = kind === 'list' ? 'Value' : 'Flag';
                if (kind === 'flags' && !FLAG_NAME_PATTERN.test(name)) {
                    toastr.warning($translate.instant('JsonFlagEditor.InvalidFlagName'));
                    return;
                }
                if (hasFlag(row.id, name)) {
                    toastr.warning($translate.instant('JsonFlagEditor.' + label + 'Exists', {id: row.id, flag: name}));
                    return;
                }
                if (!isKnownFlag(name)
                    && !window.confirm($translate.instant('JsonFlagEditor.ConfirmNew' + label, {flag: name}))) {
                    return;
                }
                if (Array.isArray(data[row.id])) {
                    data[row.id].push(name);
                } else {
                    data[row.id][name] = true;
                }
                writeBack();
            }

            function addTenant() {
                var id = (scope.newTenant.id || '').trim();
                if (!id) {
                    toastr.warning($translate.instant('JsonFlagEditor.TenantIdRequired'));
                    return;
                }
                if (has(data, id)) {
                    toastr.warning($translate.instant('JsonFlagEditor.TenantExists', {id: id}));
                    locateRow(id);
                    return;
                }
                var ids = Object.keys(data);
                var allNumeric = ids.length > 0 && ids.every(function (existingId) {
                    return /^\d+$/.test(existingId);
                });
                if (allNumeric && !/^\d+$/.test(id)) {
                    toastr.warning($translate.instant('JsonFlagEditor.TenantIdMustBeNumber'));
                    return;
                }
                data[id] = kind === 'list' ? [] : Object.create(null);
                scope.newTenant.id = '';
                writeBack();
                locateRow(id);
            }

            function removeTenant(row) {
                if (!window.confirm($translate.instant('JsonFlagEditor.ConfirmDeleteTenant', {id: row.id}))) {
                    return;
                }
                delete data[row.id];
                writeBack();
            }

            function locateRow(id) {
                scope.filter.text = '';
                scope.filter.flag = '';
                scope.highlightId = id;
                $timeout(function () {
                    var rowElement = element.find('tr[data-row-id]').filter(function () {
                        return $(this).attr('data-row-id') === id;
                    });
                    if (rowElement.length) {
                        rowElement[0].scrollIntoView({block: 'center'});
                        rowElement.find('input.json-flag-add').focus();
                    }
                });
            }

            function onAddFlagKeydown(e, row) {
                if (e.keyCode === 13) {
                    addFlag(row);
                }
            }

            function onAddTenantKeydown(e) {
                if (e.keyCode === 13) {
                    addTenant();
                }
            }

            function findRow(id) {
                return _.find(scope.rows, function (row) {
                    return row.id === id;
                });
            }

            function hasFlag(id, name) {
                return has(data, id) && entryHas(data[id], name);
            }

            function isKnownFlag(name) {
                return scope.knownFlags.some(function (flag) {
                    return flag.name === name;
                });
            }

            function isBoolean(value) {
                return value === true || value === false;
            }
        }
    };

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    // an entry is {name: value}, or a list whose items read as flags set to true
    function flagNames(entry) {
        return Array.isArray(entry) ? entry.slice() : Object.keys(entry);
    }

    function entryHas(entry, name) {
        return Array.isArray(entry) ? entry.indexOf(name) >= 0 : has(entry, name);
    }

    function flagValue(entry, name) {
        if (!entryHas(entry, name)) {
            return undefined;
        }
        return Array.isArray(entry) ? true : entry[name];
    }

    function diff(before, after) {
        var changes = [];
        var ids = Object.keys(after).concat(Object.keys(before).filter(function (id) {
            return !has(after, id);
        }));
        ids.forEach(function (id) {
            if (!has(before, id)) {
                changes.push({type: 'add', id: id, items: flagNames(after[id]).map(function (name) {
                    return {op: 'add', name: name, value: flagValue(after[id], name)};
                })});
                return;
            }
            if (!has(after, id)) {
                changes.push({type: 'remove', id: id, items: []});
                return;
            }
            var items = [];
            flagNames(after[id]).forEach(function (name) {
                var from = flagValue(before[id], name);
                var value = flagValue(after[id], name);
                if (!entryHas(before[id], name)) {
                    items.push({op: 'add', name: name, value: value});
                } else if (from !== value) {
                    items.push({op: 'change', name: name, from: from, value: value});
                }
            });
            flagNames(before[id]).forEach(function (name) {
                if (!entryHas(after[id], name)) {
                    items.push({op: 'remove', name: name});
                }
            });
            if (items.length) {
                changes.push({type: 'update', id: id, items: items});
            }
        });
        return changes;
    }
}
