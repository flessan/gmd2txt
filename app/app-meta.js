/* Single release identifier shared by the shell and service worker. */
(function (scope) {
  scope.GMDPLAYER_META = Object.freeze({
    name: "GMD Workspace",
    product: "GMD Workspace — local Geometry Dash file tools",
    version: "2.2.1",
    cacheRevision: "18"
  });
})(typeof self !== "undefined" ? self : globalThis);
