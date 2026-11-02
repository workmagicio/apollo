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
 * A JSON parser that, unlike JSON.parse, reports where a syntax error is (line / column)
 * and which object keys appear more than once. JSON.parse silently keeps the last
 * duplicate, which is how hand-edited configs lose entries.
 *
 * JsonStrictParser.parse(text, {mergeDuplicates: true}) returns
 *   {ok: true, value: ..., duplicates: [{path: [...], key: '6', lines: [3, 120]}], exactNumbers: true}
 *   {ok: false, error: {code: 'TrailingComma', line: 5, column: 9, near: '}'}, duplicates: [...]}
 * With mergeDuplicates, duplicate keys whose values are both objects are merged (later fields win)
 * and both arrays become their union; otherwise the last value wins, same as JSON.parse.
 * exactNumbers is false when some number would not be written back as it was by JSON.stringify
 * (9007199254740993 loses precision, 1.0 becomes 1, 1e3 becomes 1000).
 */
var JsonStrictParser = (function () {

    var NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    var CHINESE_PUNCTUATION = '，：“”‘’｛｝【】';

    function isPlainObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function setOwn(obj, key, value) {
        // defineProperty keeps a "__proto__" key as plain data, the way JSON.parse does
        Object.defineProperty(obj, key, {value: value, writable: true, enumerable: true, configurable: true});
    }

    // objects are merged key by key (later wins), arrays become their union, anything else: later wins
    function mergeValues(target, source) {
        if (isPlainObject(target) && isPlainObject(source)) {
            var merged = {};
            Object.keys(target).forEach(function (key) {
                setOwn(merged, key, target[key]);
            });
            Object.keys(source).forEach(function (key) {
                setOwn(merged, key, Object.prototype.hasOwnProperty.call(merged, key)
                    ? mergeValues(merged[key], source[key]) : source[key]);
            });
            return merged;
        }
        if (Array.isArray(target) && Array.isArray(source)) {
            var seen = target.map(function (element) {
                return JSON.stringify(element);
            });
            return target.concat(source.filter(function (element) {
                var id = JSON.stringify(element);
                if (seen.indexOf(id) >= 0) {
                    return false;
                }
                seen.push(id);
                return true;
            }));
        }
        return source;
    }

    function parse(text, options) {
        var mergeDuplicates = !!(options && options.mergeDuplicates);
        var pos = 0;
        var duplicates = [];
        var duplicateIndex = Object.create(null);
        var exactNumbers = true;

        function lineOf(offset) {
            var line = 1;
            for (var i = 0; i < offset; i++) {
                if (text.charCodeAt(i) === 10) {
                    line++;
                }
            }
            return line;
        }

        function fail(code, offset) {
            var at = offset === undefined ? pos : offset;
            throw {jsonStrictError: true, code: code, offset: at};
        }

        function failUnexpected() {
            if (pos >= text.length) {
                fail('UnexpectedEnd');
            }
            fail(CHINESE_PUNCTUATION.indexOf(text[pos]) >= 0 ? 'ChinesePunctuation' : 'UnexpectedToken');
        }

        function skipWhitespace() {
            while (pos < text.length) {
                var c = text[pos];
                if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
                    pos++;
                } else {
                    break;
                }
            }
        }

        function startsValue(c) {
            return c === '{' || c === '[' || c === '"' || c === '-' || (c >= '0' && c <= '9')
                || c === 't' || c === 'f' || c === 'n';
        }

        function parseValue(path) {
            skipWhitespace();
            var c = text[pos];
            if (c === '{') {
                return parseObject(path);
            }
            if (c === '[') {
                return parseArray(path);
            }
            if (c === '"') {
                return parseString();
            }
            if (c === '-' || (c >= '0' && c <= '9')) {
                return parseNumber();
            }
            if (text.startsWith('true', pos)) {
                pos += 4;
                return true;
            }
            if (text.startsWith('false', pos)) {
                pos += 5;
                return false;
            }
            if (text.startsWith('null', pos)) {
                pos += 4;
                return null;
            }
            failUnexpected();
        }

        function recordDuplicate(path, key, firstOffset, offset) {
            var id = JSON.stringify(path.concat([key]));
            var entry = duplicateIndex[id];
            if (!entry) {
                entry = {path: path, key: key, lines: [lineOf(firstOffset)]};
                duplicateIndex[id] = entry;
                duplicates.push(entry);
            }
            entry.lines.push(lineOf(offset));
        }

        function parseObject(path) {
            var obj = {};
            // no prototype, so a "__proto__" key is recorded like any other
            var keyOffsets = Object.create(null);
            pos++;
            skipWhitespace();
            if (text[pos] === '}') {
                pos++;
                return obj;
            }
            while (true) {
                skipWhitespace();
                if (text[pos] !== '"') {
                    if (pos >= text.length) {
                        fail('UnexpectedEnd');
                    }
                    fail(CHINESE_PUNCTUATION.indexOf(text[pos]) >= 0 ? 'ChinesePunctuation' : 'ExpectedKey');
                }
                var keyOffset = pos;
                var key = parseString();
                skipWhitespace();
                if (text[pos] !== ':') {
                    if (pos >= text.length) {
                        fail('UnexpectedEnd');
                    }
                    fail(text[pos] === '：' ? 'ChinesePunctuation' : 'ExpectedColon');
                }
                pos++;
                var value = parseValue(path.concat([key]));
                if (Object.prototype.hasOwnProperty.call(keyOffsets, key)) {
                    recordDuplicate(path, key, keyOffsets[key], keyOffset);
                    if (mergeDuplicates) {
                        value = mergeValues(obj[key], value);
                    }
                } else {
                    keyOffsets[key] = keyOffset;
                }
                setOwn(obj, key, value);

                skipWhitespace();
                var c = text[pos];
                if (c === ',') {
                    var commaOffset = pos;
                    pos++;
                    skipWhitespace();
                    if (text[pos] === '}') {
                        fail('TrailingComma', commaOffset);
                    }
                    continue;
                }
                if (c === '}') {
                    pos++;
                    return obj;
                }
                if (c === '"') {
                    fail('MissingComma');
                }
                if (pos >= text.length) {
                    fail('UnexpectedEnd');
                }
                fail(CHINESE_PUNCTUATION.indexOf(c) >= 0 ? 'ChinesePunctuation' : 'ExpectedCommaOrBrace');
            }
        }

        function parseArray(path) {
            var arr = [];
            pos++;
            skipWhitespace();
            if (text[pos] === ']') {
                pos++;
                return arr;
            }
            while (true) {
                arr.push(parseValue(path.concat([arr.length])));
                skipWhitespace();
                var c = text[pos];
                if (c === ',') {
                    var commaOffset = pos;
                    pos++;
                    skipWhitespace();
                    if (text[pos] === ']') {
                        fail('TrailingComma', commaOffset);
                    }
                    continue;
                }
                if (c === ']') {
                    pos++;
                    return arr;
                }
                if (pos >= text.length) {
                    fail('UnexpectedEnd');
                }
                if (startsValue(c)) {
                    fail('MissingComma');
                }
                fail(CHINESE_PUNCTUATION.indexOf(c) >= 0 ? 'ChinesePunctuation' : 'ExpectedCommaOrBracket');
            }
        }

        function parseString() {
            var start = pos;
            pos++;
            while (pos < text.length) {
                var c = text[pos];
                if (c === '"') {
                    pos++;
                    return JSON.parse(text.slice(start, pos));
                }
                if (c === '\\') {
                    var next = text[pos + 1];
                    if (next === 'u') {
                        if (!/^[0-9a-fA-F]{4}$/.test(text.substr(pos + 2, 4))) {
                            fail('InvalidEscape');
                        }
                        pos += 6;
                    } else if (next !== undefined && '"\\/bfnrt'.indexOf(next) >= 0) {
                        pos += 2;
                    } else {
                        fail('InvalidEscape');
                    }
                    continue;
                }
                if (c < ' ') {
                    fail('ControlCharInString');
                }
                pos++;
            }
            fail('UnterminatedString', start);
        }

        function parseNumber() {
            NUMBER_PATTERN.lastIndex = pos;
            var match = NUMBER_PATTERN.exec(text);
            if (!match) {
                fail('InvalidNumber');
            }
            pos += match[0].length;
            var number = Number(match[0]);
            if (String(number) !== match[0]) {
                exactNumbers = false;
            }
            return number;
        }

        try {
            skipWhitespace();
            if (pos >= text.length) {
                fail('Empty');
            }
            var value = parseValue([]);
            skipWhitespace();
            if (pos < text.length) {
                fail('TrailingContent');
            }
            return {ok: true, value: value, duplicates: duplicates, exactNumbers: exactNumbers};
        } catch (e) {
            if (!e || !e.jsonStrictError) {
                throw e;
            }
            var line = 1, lineStart = 0;
            for (var i = 0; i < e.offset; i++) {
                if (text.charCodeAt(i) === 10) {
                    line++;
                    lineStart = i + 1;
                }
            }
            return {
                ok: false,
                error: {
                    code: e.code,
                    line: line,
                    column: e.offset - lineStart + 1,
                    near: text.charAt(e.offset)
                },
                duplicates: duplicates
            };
        }
    }

    return {
        parse: parse,
        isPlainObject: isPlainObject
    };
})();
