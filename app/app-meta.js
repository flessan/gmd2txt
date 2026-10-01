/* Single release identifier shared by the shell and service worker. */
(function (scope) {
  scope.GMDPLAYER_META = Object.freeze({
    name: "gmd2txt",
    product: "gmd2txt — Geometry Dash level file converter",
    version: "2.0.0",
    cacheRevision: "13"
  });
})(typeof self !== "undefined" ? self : globalThis);
