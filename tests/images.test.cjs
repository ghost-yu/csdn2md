const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load the userscript's actual classes without starting its browser UI or CDN loader.
const source = fs.readFileSync(path.join(__dirname, '..', 'csdn2md.user.js'), 'utf8');
const sandbox = {
    URL, Blob, console: { info() {}, warn() {} },
    JSZip: {}, fflate: {}, streamSaver: {}, katex: {},
};
vm.runInNewContext(source.replace('    initApp();',
    '    globalThis.testClasses = { FileManager, MarkdownConverter };'), sandbox);
const { FileManager, MarkdownConverter } = sandbox.testClasses;

function image(attributes, standalone = false) {
    const node = {
        nodeType: 1, tagName: 'IMG', baseURI: 'https://blog.csdn.net/author/article/details/123',
        getAttribute: (name) => attributes[name] || null,
    };
    node.parentElement = {
        tagName: 'P',
        childNodes: standalone ? [node] : [{ nodeType: 3, textContent: 'before' }, node],
    };
    return node;
}

async function convert(attributes, context = {}, standalone = false) {
    const downloads = [];
    const converter = new MarkdownConverter({
        async addWebImageFile(url) { downloads.push(url); return './assets/1.png'; },
    });
    const raw = await converter.handleImage(image(attributes, standalone), {
        saveWebImages: true, ...context,
    });
    return { markdown: converter.postProcessMarkdown(raw).trim(), downloads };
}

test('CSDN formulas without mathcode remain inline, including nested brackets', async () => {
    const latex = '[196, 768]';
    const result = await convert({ src: `https://latex.csdn.net/eq?${encodeURIComponent(latex)}`, alt: latex });
    assert.equal(result.markdown, '$[196, 768]$');
    assert.deepEqual(result.downloads, []);
});

test('formula URL fallback preserves literal plus signs and percent escapes', async () => {
    const result = await convert({ src: '//latex.csdn.net/eq?x+y%3Dz%20%2B%201#pic_center' });
    assert.equal(result.markdown, '$x+y=z + 1$');
    assert.deepEqual(result.downloads, []);
});

test('empty equation placeholders do not create broken assets', async () => {
    const result = await convert({ src: 'https://latex.csdn.net/eq?', class: 'mathcode' });
    assert.equal(result.markdown, '');
    assert.deepEqual(result.downloads, []);
});

test('mathcode formulas still work and inline formulas do not introduce paragraph breaks', async () => {
    const result = await convert({ src: 'https://example.com/math.png', class: 'other mathcode', alt: 'x_i' });
    assert.equal(result.markdown, '$x_i$');
    assert.deepEqual(result.downloads, []);
});

test('standalone formulas use display math, while table cells remain inline', async () => {
    const attrs = { src: 'https://latex.csdn.net/eq?x', alt: 'x' };
    assert.equal((await convert(attrs, {}, true)).markdown, '$$\nx\n$$');
    assert.equal((await convert(attrs, { isInTableCell: true }, true)).markdown, '$x$');
});

test('normal image alt text is not mistaken for a formula', async () => {
    const result = await convert({ src: 'https://example.com/image.png?token=a+b&size=large', alt: 'N' });
    assert.equal(result.markdown, '![N](./assets/1.png)');
    assert.deepEqual(result.downloads, ['https://example.com/image.png?token=a+b&size=large']);
});

test('lazy image URLs resolve against the article URL in fetch mode', async () => {
    for (const attribute of ['data-src', 'data-original']) {
        const result = await convert({ src: 'placeholder.gif', [attribute]: '/images/real.png' }, {
            articleUrl: 'https://example.com/article/123',
        });
        assert.deepEqual(result.downloads, ['https://example.com/images/real.png']);
    }
    assert.deepEqual((await convert({})).downloads, []);
});

test('malformed formula URL falls back to the original image', async () => {
    const result = await convert({ src: 'https://latex.csdn.net/eq?%ZZ' });
    assert.deepEqual(result.downloads, ['https://latex.csdn.net/eq?%ZZ']);
});

test('aligned paragraphs retain converted math and local image references', async () => {
    const converter = new MarkdownConverter({});
    converter.processChildren = async () => '$x+y$ ![](./assets/1.png)';
    converter.addPicCenterToImages = () => {};
    for (const alignment of ['center', 'right']) {
        const node = {
            getAttribute: (name) => name === 'style' ? `text-align:${alignment}` : null,
            innerHTML: '<img src="https://latex.csdn.net/eq?x+y">',
        };
        const markdown = await converter.handleParagraph(node, {});
        assert(markdown.includes('$x+y$ ![](./assets/1.png)'));
        assert(!markdown.includes('latex.csdn.net'));
        assert(!/<\/?div\b/i.test(markdown));
    }
});

test('table cells collapse paragraph and explicit breaks without losing text or pipes', async () => {
    const converter = new MarkdownConverter({});
    converter.processChildren = async () => '\n<br>\n**Title**\n\n<br/>\nDetail | value\n<br/><br/>\n';
    const context = { isInTableCell: true };
    const markdown = await converter.handleTableCell({}, context);
    assert.equal(markdown, '**Title**<br/>Detail \\| value');
    assert.equal(context.isInTableCell, true);
});

test('table cells retain a single necessary break and no empty boundary breaks', async () => {
    const converter = new MarkdownConverter({});
    for (const content of ['first\n\nsecond', 'first<br />second', 'first<br/>\n\nsecond']) {
        converter.processChildren = async () => content;
        assert.equal(await converter.handleTableCell({}, {}), 'first<br/>second');
    }
    converter.processChildren = async () => '<br/>\n<br/>\n';
    assert.equal(await converter.handleTableCell({}, {}), ' ');
});

test('table cleanup retains formula separation and cloned cell context', async () => {
    const converter = new MarkdownConverter({});
    const context = { isInTableCell: false };
    converter.processChildren = async (node, childContext) => {
        assert.equal(childContext.isInTableCell, true);
        assert.notEqual(childContext, context);
        return `1) first${converter.CONSTANT_DOUBLE_NEW_LINE}${converter.SEPARATION_BEAUTIFICATION}2) second`;
    };
    assert.equal(await converter.handleTableCell({}, context), '1) first<br/>2) second');
    assert.equal(context.isInTableCell, false);
});

test('asset downloading preserves query strings, extracts extensions and deduplicates', async () => {
    const manager = new FileManager();
    const requests = [];
    manager.fetchResource = async (url) => { requests.push(url); return new Blob(['image']); };
    const url = 'https://example.com/image.PNG!resize?token=a+b&size=(2)#pic_center';
    assert.equal(await manager.addWebImageFile(url, 'assets', '01_'), './assets/01_1.png');
    assert.equal(await manager.addWebImageFile(url, 'assets', '01_'), './assets/01_1.png');
    assert.equal(await manager.addWebImageFile(url.replace('token=a+b', 'token=c'), 'assets', '01_'), './assets/01_2.png');
    assert.equal(manager.fileQueue.length, 2);
    assert.deepEqual(requests, [url.split('#')[0], url.replace('token=a+b', 'token=c').split('#')[0]]);
    await Promise.all(manager.fileQueue.map((file) => file.content));
});
