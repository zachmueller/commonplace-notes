import { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { Node } from 'unist';
import { Position } from 'unist';

interface NodeWithPosition extends Node {
	position?: Position;
	data?: {
		hName?: string;
		hProperties?: {
			className?: string[];
			[key: string]: any;
		};
	};
}

const remarkLineNumbers: Plugin = () => {
	return (tree) => {
		visit(tree, (node: NodeWithPosition) => {
			if (node.position?.start?.line) {
				// Ensure data and hProperties exist
				node.data = node.data || {};
				node.data.hProperties = node.data.hProperties || {};

				// Set the properties that will become HTML attributes
				const props = node.data.hProperties;
				props.className = Array.isArray(props.className) ? props.className : [];
				props.className.push('line');
				props['data-line'] = node.position.start.line;
			}
			return true;
		});
	};
};

export default remarkLineNumbers;