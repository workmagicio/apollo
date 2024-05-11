directive_module.directive('diffviewer', releaseDiffModalDirective);

function releaseDiffModalDirective($translate, toastr, AppUtil, EventManager, ReleaseService, NamespaceBranchService) {
    return {
        restrict: 'E',
        templateUrl: AppUtil.prefixPath() + '/views/component/diff-viewer.html',
        transclude: true,
        replace: true,
        scope: {
            appId: '=',
            env: '=',
            cluster: '='
        },
        link: function (scope,element) {
             console.log('diff viewer directive',element)
              scope.hideDiffViewer = hideDiffViewer;
              function hideDiffViewer() {
                console.log('hide diff viewer');
                AppUtil.hideModal('#diffViewer');
                if(typeof window.unmountDiffViewer === 'function') {
                  window.unmountDiffViewer();
                }
              }
        }
    }
}


