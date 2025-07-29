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
directive_module.directive('releasemodal', releaseModalDirective);

function releaseModalDirective($translate, toastr, AppUtil, EventManager, ReleaseService, NamespaceBranchService) {
    return {
        restrict: 'E',
        templateUrl: AppUtil.prefixPath() + '/views/component/release-modal-diff.html',
        transclude: true,
        replace: true,
        scope: {
            appId: '=',
            env: '=',
            cluster: '='
        },
        link: function (scope) {

            scope.switchReleaseChangeViewType = switchReleaseChangeViewType;
            scope.release = release;

            scope.releaseBtnDisabled = false;
            scope.releaseChangeViewType = 'compareWithPublishedValue';
            scope.isComparePublished = true;
            scope.releaseComment = '';
            scope.isEmergencyPublish = false;

            scope.showDiffViewer = showDiffViewer;
            scope.hideDiffViewer = hideDiffViewer;
            scope.releaseAfterCheckChange = false;
            scope.releaseItemsNeedToCheck = {};
            scope.releaseItemsAllChecked = false;

            EventManager.subscribe(EventManager.EventType.PUBLISH_NAMESPACE,
                function (context) {

                    var namespace = context.namespace;
                    scope.toReleaseNamespace = context.namespace;
                    scope.isEmergencyPublish = !!context.isEmergencyPublish;

                    if (scope.toReleaseNamespace.viewName === 'frontend' || scope.toReleaseNamespace.parentAppId === '123456') {
                    scope.releaseAfterCheckChange = true;
                    }

                    if (scope.releaseAfterCheckChange) {
                    namespace.items
                        .filter((item) => item.isModified)
                        .map((item) => {
                        scope.releaseItemsNeedToCheck[item.$$hashKey] = false;
                        return item;
                        });
                    }

                    var date = new Date().Format("yyyyMMddhhmmss");
                    if (namespace.mergeAndPublish) {
                        namespace.releaseTitle = date + "-gray-release-merge-to-master";
                    } else if (namespace.isBranch) {
                        namespace.releaseTitle = date + "-gray";
                    } else {
                        namespace.releaseTitle = date + "-release";
                    }

                    AppUtil.showModal('#releaseModal');
                });

            function release() {
                if (scope.toReleaseNamespace.mergeAndPublish) {
                    mergeAndPublish();
                } else if (scope.toReleaseNamespace.isBranch) {
                    grayPublish();
                } else {
                    publish();
                }

            }

            function publish() {
                scope.releaseBtnDisabled = true;
                ReleaseService.publish(scope.appId, scope.env,
                    scope.toReleaseNamespace.baseInfo.clusterName,
                    scope.toReleaseNamespace.baseInfo.namespaceName,
                    scope.toReleaseNamespace.releaseTitle,
                    scope.releaseComment,
                    scope.isEmergencyPublish).then(
                        function (result) {
                            AppUtil.hideModal('#releaseModal');
                            toastr.success($translate.instant('ReleaseModal.Published'));

                            scope.releaseBtnDisabled = false;

                            EventManager.emit(EventManager.EventType.REFRESH_NAMESPACE,
                                {
                                    namespace: scope.toReleaseNamespace
                                })

                        }, function (result) {
                            scope.releaseBtnDisabled = false;
                            toastr.error(AppUtil.errorMsg(result), $translate.instant('ReleaseModal.PublishFailed'));

                        }
                    );

            }

            function grayPublish() {
                scope.releaseBtnDisabled = true;
                ReleaseService.grayPublish(scope.appId, scope.env,
                    scope.toReleaseNamespace.parentNamespace.baseInfo.clusterName,
                    scope.toReleaseNamespace.baseInfo.namespaceName,
                    scope.toReleaseNamespace.baseInfo.clusterName,
                    scope.toReleaseNamespace.releaseTitle,
                    scope.releaseComment,
                    scope.isEmergencyPublish).then(
                        function (result) {
                            AppUtil.hideModal('#releaseModal');
                            toastr.success($translate.instant('ReleaseModal.GrayscalePublished'));

                            scope.releaseBtnDisabled = false;

                            //refresh item status
                            for (let index = 0; index < scope.toReleaseNamespace.branchItems.length; index++) {
                                const item = scope.toReleaseNamespace.branchItems[index];
                                if (item.isDeleted) {
                                    scope.toReleaseNamespace.branchItems.splice(index, 1);
                                    index--;
                                } else {
                                    item.isModified = false;
                                }
                            }

                            //reset namespace status
                            scope.toReleaseNamespace.itemModifiedCnt = 0;
                            scope.toReleaseNamespace.lockOwner = undefined;

                            //check rules
                            if (!scope.toReleaseNamespace.rules
                                || !scope.toReleaseNamespace.rules.ruleItems
                                || !scope.toReleaseNamespace.rules.ruleItems.length) {

                                scope.toReleaseNamespace.viewType = 'rule';
                                AppUtil.showModal('#grayReleaseWithoutRulesTips');
                            }

                        }, function (result) {
                            scope.releaseBtnDisabled = false;
                            toastr.error(AppUtil.errorMsg(result), $translate.instant('ReleaseModal.GrayscalePublishFailed'));

                        });
            }

            function mergeAndPublish() {

                NamespaceBranchService.mergeAndReleaseBranch(scope.appId,
                    scope.env,
                    scope.cluster,
                    scope.toReleaseNamespace.baseInfo.namespaceName,
                    scope.toReleaseNamespace.baseInfo.clusterName,
                    scope.toReleaseNamespace.releaseTitle,
                    scope.releaseComment,
                    scope.isEmergencyPublish,
                    scope.toReleaseNamespace.mergeAfterDeleteBranch)
                    .then(function (result) {

                        toastr.success($translate.instant('ReleaseModal.AllPublished'));

                        EventManager.emit(EventManager.EventType.REFRESH_NAMESPACE,
                            {
                                namespace: scope.toReleaseNamespace
                            })

                    }, function (result) {
                        toastr.error(AppUtil.errorMsg(result), $translate.instant('ReleaseModal.AllPublishFailed'));
                    });

                AppUtil.hideModal('#releaseModal');
            }

            function switchReleaseChangeViewType(type) {
                scope.releaseChangeViewType = type;
                scope.isCompareMaster = type === 'compareWithMasterValue';
                scope.isComparePublished = type === 'compareWithPublishedValue';
                scope.isNoCompare = type === 'release';
            }

            function showDiffViewer(key, oldValue, newValue) {
                AppUtil.showModal('#diffViewer');
                if (typeof window.renderDiffViewer === 'function') {
                    window.renderDiffViewer(oldValue, newValue);
                }
                if (scope.releaseAfterCheckChange) {
                    if (scope.releaseItemsNeedToCheck[key] === false) {
                        scope.releaseItemsNeedToCheck[key] = true;
                    }
                    scope.releaseItemsAllChecked = Object.values(scope.releaseItemsNeedToCheck).every((item) => item === true);
                }
            }

            function hideDiffViewer() {
                AppUtil.hideModal('#diffViewer');
                if (typeof window.unmountDiffViewer === 'function') {
                    window.unmountDiffViewer();
                }
            }
        }
    }
}
