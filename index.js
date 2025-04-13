const fs = require('fs');
const axios = require('axios');
const { JSDOM } = require('jsdom');

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