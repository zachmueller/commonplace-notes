import { scaffold } from './_scaffold-helper';

export const LINE_NUMBERS = scaffold({
	name: 'line-numbers',
	stage: 'remark',
	order: 30,
	description: 'Tag every node with class="line" and data-line=<source line>.',
	doc: `Built-in stage: records each node's source line number as a
\`data-line\` HTML attribute (and adds \`class="line"\`), so the published SPA can
map rendered elements back to source lines. This is a faithful port of the
plugin's original \`remarkLineNumbers\` logic, written against the toolkit.`,
	code: `// In scope: libs, context, app, utils — NO imports.
// defineTransform wraps a raw (tree) => void visitor into a unified plugin.
return libs.defineTransform((tree) => {
  libs.visit(tree, (node) => {
    if (node.position?.start?.line) {
      node.data = node.data || {};
      node.data.hProperties = node.data.hProperties || {};
      const props = node.data.hProperties;
      props.className = Array.isArray(props.className) ? props.className : [];
      props.className.push('line');
      props['data-line'] = node.position.start.line;
    }
    return true;
  });
});`,
});
