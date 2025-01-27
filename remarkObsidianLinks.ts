import { Plugin } from 'unified'
import { Node } from 'unist'
import { visit } from 'unist-util-visit'
import { PathUtils } from './utils/path'
import { Link, Text, Parent } from 'mdast'

interface ObsidianLinksOptions {
  baseUrl: string;
  resolveInternalLinks: (linkText: string) => {
    slug: string;
    displayText?: string;
  } | null;
}

const remarkObsidianLinks: Plugin<[ObsidianLinksOptions]> = (options) => {
  return (tree) => {
    visit(tree, 'text', (node: Text, index, parent: Parent | null) => {
      if (!parent) return;
      
      const matches = Array.from(node.value.matchAll(/\[\[(.*?)\]\]/g));
      
      if (matches.length === 0) return;

      const children: (Text | Link)[] = [];
      let lastIndex = 0;

      matches.forEach((match) => {
        // Add text before the link
        if (match.index! > lastIndex) {
          children.push({
            type: 'text',
            value: node.value.slice(lastIndex, match.index),
          } as Text);
        }

        const [fullMatch, linkText] = match;
        const resolved = options.resolveInternalLinks(linkText);

        if (resolved) {
          // Create link node
          children.push({
            type: 'link',
            url: `${options.baseUrl}/${resolved.slug}`,
            children: [{
              type: 'text',
              value: resolved.displayText || linkText,
            }],
          } as Link);
        } else {
          // If link can't be resolved, leave as text
          children.push({
            type: 'text',
            value: fullMatch,
          } as Text);
        }

        lastIndex = match.index! + fullMatch.length;
      });

      // Add remaining text
      if (lastIndex < node.value.length) {
        children.push({
          type: 'text',
          value: node.value.slice(lastIndex),
        } as Text);
      }

      // Replace the current node with our new children
      parent.children.splice(index!, 1, ...children);
    });
  };
};

export default remarkObsidianLinks;