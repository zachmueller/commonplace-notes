import { Plugin } from 'unified';
import { Node } from 'unist';
import { visit } from 'unist-util-visit';
import { PathUtils } from './utils/path';
import { Link, Text, Parent } from 'mdast';
import path from 'path';

interface ObsidianLinksOptions {
  //baseUrl: string;
  currentSlug: string;
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
		  // Calculate relative path
          const relativePath = createRelativePath(options.currentSlug, resolved.slug);
          
		  // Create link node
          children.push({
            type: 'link',
            url: relativePath,
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

// Helper function to create relative paths
function createRelativePath(fromSlug: string, toSlug: string): string {
  // Convert slugs to directory-like paths
  const fromParts = fromSlug.split('/');
  const toParts = toSlug.split('/');
  
  // Remove the filename part from fromParts
  fromParts.pop();
  
  // Calculate the relative path
  const relativePath = path.relative(
    fromParts.join('/'),
    toParts.join('/')
  );
  
  // Ensure the path starts with ./ or ../
  return relativePath.startsWith('.')
    ? relativePath + '.html'
    : './' + relativePath + '.html';
}

export default remarkObsidianLinks;