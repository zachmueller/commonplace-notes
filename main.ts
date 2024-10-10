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
