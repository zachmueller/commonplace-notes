import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';

// Testing unified
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

async function testUnified() {
	const processor = unified()
		.use(remarkParse)
		.use(remarkRehype)
		.use(rehypeStringify);

	const result = await processor.process('# Hello World');
	console.log(result.toString());
}

// Testing gray-matter
import matter from 'gray-matter';

function testGrayMatter() {
	const file = '---\ntitle: Test\n---\nContent here';
	const result = matter(file);
	console.log(result);
}

// Testing JSX
import { Element } from 'hast';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { jsx, jsxs, Fragment } from 'preact/jsx-runtime';

function testHastToJsx() {
  const hast: Element = {
    type: 'element',
    tagName: 'div',
    properties: { className: 'test' },
    children: [{ type: 'text', value: 'Hello' }]
  };
  
  const result = toJsxRuntime(hast, { Fragment, jsx, jsxs });
  console.log(result);
}

// Testing rehype
import rehypeRaw from 'rehype-raw';

async function testRehypeRaw() {
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeStringify);

  const result = await processor.process('# Hello\n\n<div>Raw HTML</div>');
  console.log(result.toString());
}

// Testing rehype for slugs
import rehypeSlug from 'rehype-slug';

async function testRehypeSlug() {
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeStringify);

  const result = await processor.process('# Hello World');
  console.log(result.toString());
}

// Testing rehype for linking headings
import rehypeAutolinkHeadings from 'rehype-autolink-headings';

async function testRehypeAutolinkHeadings() {
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings)
    .use(rehypeStringify);

  const result = await processor.process('# Hello World');
  console.log(result.toString());
}

// Testing LaTeX
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

async function testRemarkMath() {
  const processor = unified()
    .use(remarkParse)
    .use(remarkMath)
    .use(remarkRehype)
    .use(rehypeKatex)
    .use(rehypeStringify);

  const result = await processor.process('$E = mc^2$');
  console.log(result.toString());
}

// Testing micromorph
import { diff, patch } from 'micromorph';

function testMicromorph() {
    const oldHtml = '<div><p>Hello</p></div>';
    const newHtml = '<div><p>Hello, World!</p></div>';
    
    // Create temporary containers
    const oldContainer = document.createElement('div');
    const newContainer = document.createElement('div');
    oldContainer.innerHTML = oldHtml;
    newContainer.innerHTML = newHtml;
    
    // Generate the patch
    const patchObj = diff(oldContainer, newContainer);
    
    if (patchObj) {
        // Apply the patch
        patch(oldContainer, patchObj).then(() => {
            console.log('Micromorph result:', oldContainer.innerHTML);
        });
    } else {
        console.log('No differences found');
    }
}

// Testing GitHub slugger
import GithubSlugger from 'github-slugger';

function testGithubSlugger() {
	const slugger = new GithubSlugger();
    const slug1 = slugger.slug('Hello World');
    const slug2 = slugger.slug('Hello World'); // Should be different
    
    console.log('Slugs:', slug1, slug2);
}

// Testing Flexsearch
import FlexSearch from 'flexsearch';

function testFlexsearch() {
    const index = new FlexSearch.Document<{id: number, title: string, content: string}>({
        document: {
            id: 'id',
            index: ['title', 'content']
        }
    });

    index.add(1, { id: 1, title: 'Hello', content: 'World' });
    index.add(2, { id: 2, title: 'Goodbye', content: 'World' });

    const results = index.search('world');
    console.log('Flexsearch results:', results);
}

// Testing d3
import * as d3 from 'd3';

function testD3() {
    const data = [1, 2, 3, 4, 5];
    const sum = d3.sum(data);
    const max = d3.max(data);
    
    console.log('D3 results:', { sum, max });
}

// Testing yaml parser
import yaml from 'js-yaml';

function testYaml() {
    const yamlString = `
    title: My Document
    tags:
      - tag1
      - tag2
    `;
    
    const parsed = yaml.load(yamlString);
    console.log('YAML parsed:', parsed);
}

// Testing hast util to string
import { toString } from 'hast-util-to-string';
import { h } from 'hastscript';

function testHastUtilToString() {
    // Create a simple HAST tree
    const tree = h('div', [
        h('h1', 'Hello'),
        h('p', 'This is a paragraph'),
        h('ul', [
            h('li', 'Item 1'),
            h('li', 'Item 2')
        ])
    ]);

    // Convert the tree to a string
    const result = toString(tree);

    console.log('HAST to string result:', result);
}

// Testing hast util to html
import { toHtml } from 'hast-util-to-html';

function testHastUtilToHtml() {
    // Create a simple HAST tree
    const tree = h('div', { class: 'container' }, [
        h('h1', 'Hello, HAST!'),
        h('p', 'This is a paragraph with a ', h('a', { href: 'https://example.com' }, 'link')),
        h('ul', [
            h('li', 'Item 1'),
            h('li', 'Item 2')
        ])
    ]);

    // Convert the tree to HTML
    const html = toHtml(tree);

    console.log('HAST to HTML result:');
    console.log(html);
}

// Testing absolute URL
import isAbsoluteUrl from 'is-absolute-url';

function testIsAbsoluteUrl() {
    const absoluteUrl = 'https://example.com/page';
    const relativeUrl = 'path/to/page';
    const rootRelativeUrl = '/path/to/page';

    console.log('Is absolute URL:', isAbsoluteUrl(absoluteUrl));
    console.log('Is relative URL:', isAbsoluteUrl(relativeUrl));
    console.log('Is root-relative URL:', isAbsoluteUrl(rootRelativeUrl));
}

// Testing preact
import { h as preactH } from 'preact';
import renderToString from 'preact-render-to-string';

function testPreactRenderToString() {
    // Define a simple Preact component
    const MyComponent = ({ name }: { name: string }) => preactH('div', null, `Hello, ${name}!`);

    // Render the component to a string
    const result = renderToString(preactH(MyComponent, { name: 'World' }));

    console.log('Preact render to string result:', result);
}

// Testing Mathjax
import rehypeMathjax from "rehype-mathjax/svg.js";

async function testRehypeMathjax() {
	const processor = unified()
		.use(remarkParse)
		.use(remarkMath)
		.use(remarkRehype)
		.use(rehypeMathjax)
		.use(rehypeStringify);

	const result = await processor.process('$E = mc^2$');
	console.log('Rehype MathJax result:');
	console.log(result.toString());
}

// Testing mermaid
import mermaid from 'mermaid';

function testMermaid() {
    const diagram = `
    graph TD
    A[Client] --> B[Load Balancer]
    B --> C[Server01]
    B --> D[Server02]
    `;

    mermaid.initialize({ startOnLoad: false });

    mermaid.render('mermaid-diagram', diagram).then(({ svg }) => {
        console.log('Mermaid rendered SVG:');
        console.log(svg);
    }).catch(error => {
        console.error('Mermaid rendering error:', error);
    });
}

// Testing mdast to hast
import { toHast } from 'mdast-util-to-hast';

function testMdastUtilToHast() {
    // Create a simple object that resembles an mdast structure
    const mdastLike = {
        type: 'root',
        children: [
            {
                type: 'heading',
                depth: 1,
                children: [{ type: 'text', value: 'Hello, mdast!' }]
            },
            {
                type: 'paragraph',
                children: [{ type: 'text', value: 'This is a paragraph.' }]
            }
        ]
    };

    // Convert mdast-like object to hast
    const hast = toHast(mdastLike as any);

    console.log('mdast to hast result:');
    console.log(JSON.stringify(hast, null, 2));
}

// Testing unist visit
import { visit } from 'unist-util-visit';

function testUnistUtilVisit() {
	// Create a simple Markdown AST
	const tree = {
		type: 'root',
		children: [
			{ type: 'heading', depth: 1, children: [{ type: 'text', value: 'Title' }] },
			{ type: 'paragraph', children: [{ type: 'text', value: 'This is a paragraph.' }] },
			{ type: 'heading', depth: 2, children: [{ type: 'text', value: 'Subtitle' }] },
		]
	};

	// Use visit to find all headings
	const headings: any[] = [];
	visit(tree, 'heading', (node) => {
		headings.push(node);
	});

	console.log('Unist-util-visit result:');
	console.log('Number of headings found:', headings.length);
	headings.forEach((heading, index) => {
		console.log(`Heading ${index + 1}: Depth ${heading.depth}, Text: ${heading.children[0].value}`);
	});
}

// Testing vFile
import { VFile } from 'vfile';
import { reporter } from 'vfile-reporter';

async function testVFile() {
    try {
		console.log('Starting VFile test');

		console.log('VFile:', VFile);
		console.log('reporter:', reporter);

		const file = new VFile({
			path: 'example.md',
			contents: '# Hello\n\nThis is a test file.'
		});
		console.log('VFile created');

		file.message('This is an info message');
		file.info('Another info message');

		// Instead of calling fail(), which throws an error, let's add it as a message
		file.message(new Error('This is an error message'));

		console.log('Messages added to VFile');

		console.log('VFile contents:', file.toString());

		console.log('VFile report:');
		console.log(reporter(file));

		console.log('VFile test completed');
	} catch (error) {
		console.error('Error in testVFile:', error);
		console.error('Error name:', error.name);
		console.error('Error message:', error.message);
		console.error('Error stack:', error.stack);
    }
}

// END OF TESTING ---------------------------- ----------------------------

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default'
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();
		await testUnified();
		testGrayMatter();
		testHastToJsx();
		testRehypeRaw();
		testRehypeSlug();
		testRehypeAutolinkHeadings();
		testRemarkMath();
		testMicromorph();
		testGithubSlugger();
		testFlexsearch();
		testD3();
		testYaml();
		testHastUtilToString();
		testHastUtilToHtml();
		testIsAbsoluteUrl();
		testPreactRenderToString();
		testRehypeMathjax();
		testMermaid();
		testMdastUtilToHast();
		testUnistUtilVisit();
		await testVFile();
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Setting #1')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));
	}
}
