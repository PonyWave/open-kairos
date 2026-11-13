Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const require_http_exception = require("../http-exception.js");
const require_request_constants = require("../request/constants.js");
const require_utils_url = require("./url.js");
//#region src/utils/mount.ts
const countTrailingSlashes = (path) => {
	let index = path.length;
	while (index > 0 && path.charCodeAt(index - 1) === 47) index--;
	return path.length - index;
};
const getPathPrefixLength = (c, pathPrefix, routePath) => {
	if (!/[:*]/.test(pathPrefix)) return pathPrefix.length;
	const path = c.req.path;
	const matchResult = c.req[require_request_constants.GET_MATCH_RESULT];
	const paramNames = /* @__PURE__ */ new Set();
	let length = 0;
	for (const part of require_utils_url.splitRoutingPath(pathPrefix)) {
		if (part[0] === ":" && part.endsWith("}?")) throw new Error(`mount(): Optional regular expression parameters are not supported in "${routePath}".`);
		const pattern = require_utils_url.getPattern(part);
		if (pattern && pattern !== "*") {
			const name = pattern[1];
			if (paramNames.has(name)) throw new Error(`mount(): Duplicate path parameter "${name}" in "${routePath}".`);
			paramNames.add(name);
		}
		if (pattern && pattern !== "*" && pattern[2] !== true) {
			const value = matchResult.length === 2 ? matchResult[1][matchResult[0][c.req.routeIndex][1][pattern[1]]] : matchResult[0][c.req.routeIndex][1][pattern[1]];
			length += value.length + 1;
		} else if (pattern || part.endsWith("*")) {
			const end = path.indexOf("/", length + 1);
			length = end === -1 ? path.length : end;
		} else length += part.length + 1;
	}
	return length;
};
const createMountedRequest = (c, pathPrefix, routePath) => {
	if (/[^/]\*$/.test(routePath)) throw new Error(`mount(): Wildcard must follow "/" in "${routePath}".`);
	const prefixLength = getPathPrefixLength(c, pathPrefix, routePath);
	const path = c.req.path.slice(prefixLength) || "/";
	if (prefixLength > c.req.path.length || path[0] !== "/" || /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(path)) throw new require_http_exception.HTTPException(400, { message: "Invalid mounted path" });
	const rawUrl = c.req.raw.url;
	if (/^[^/?#]*\/\/[^/?#\\]*[?#\\]/.test(rawUrl)) throw new require_http_exception.HTTPException(400, { message: "Invalid mounted path" });
	const rawPathEnd = rawUrl.search(/[?#]/);
	const rawTrailingSlashes = countTrailingSlashes(rawPathEnd === -1 ? rawUrl : rawUrl.slice(0, rawPathEnd));
	if (rawTrailingSlashes > 1 && countTrailingSlashes(c.req.path) === rawTrailingSlashes - 1) throw new require_http_exception.HTTPException(400, { message: "Invalid mounted path" });
	const url = new URL(rawUrl);
	url.pathname = path.replace(/[\\\t\n\r]/g, encodeURIComponent);
	if (path.includes("%")) {}
	return new Request(url, c.req.raw);
};
//#endregion
exports.createMountedRequest = createMountedRequest;
