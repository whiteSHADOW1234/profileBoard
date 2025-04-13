import { createRequire as __WEBPACK_EXTERNAL_createRequire } from "module";
/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 473:
/***/ ((module) => {

module.exports = eval("require")("axios");


/***/ }),

/***/ 740:
/***/ ((module) => {

module.exports = eval("require")("jsdom");


/***/ }),

/***/ 896:
/***/ ((module) => {

"use strict";
module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("fs");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
const fs = __nccwpck_require__(896);
const axios = __nccwpck_require__(473);
const { JSDOM } = __nccwpck_require__(740);

const layout = core.getInput('layout', { required: true });

async function fetchSVGContent(url) {
try {
    const res = await axios.get(url);
    return res.data;
} catch (e) {
    console.error(`Failed to fetch ${url}:`, e.message);
    return null;
}
}

async function main() {
const dom = new JSDOM(`<!DOCTYPE html><svg xmlns='http://www.w3.org/2000/svg'></svg>`);
const svg = dom.window.document.querySelector('svg');
svg.setAttribute('width', '1000');
svg.setAttribute('height', '1000');

for (const item of layout) {
    const g = dom.window.document.createElement('g');
    g.setAttribute('transform', `translate(${item.x}, ${item.y})`);
    g.setAttribute('width', item.width);
    g.setAttribute('height', item.height);

    if (item.type === 'svg' || item.url.endsWith('.svg')) {
    let content = fs.readFileSync(item.url, 'utf8');
    const inner = new JSDOM(content).window.document.querySelector('svg');
    g.innerHTML = inner.innerHTML;
    } else if (item.url.startsWith('http')) {
    const remote = await fetchSVGContent(item.url);
    if (remote) {
        const remoteDOM = new JSDOM(remote);
        const remoteSVG = remoteDOM.window.document.querySelector('svg');
        if (remoteSVG) g.innerHTML = remoteSVG.innerHTML;
        else g.innerHTML = `<image href='${item.url}' width='${item.width}' height='${item.height}'/>`;
    }
    } else {
    g.innerHTML = `<image href='${item.url}' width='${item.width}' height='${item.height}'/>`;
    }

    svg.appendChild(g);
}

fs.writeFileSync('merged.svg', dom.serialize());
}

main();
module.exports = __webpack_exports__;
/******/ })()
;