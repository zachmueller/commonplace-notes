import { scaffold } from './_scaffold-helper';

export const REMARK_ATTACHMENTS = scaffold({
	name: 'remark-attachments',
	stage: 'remark',
	order: 38,
	description: 'Render links and embeds of non-Markdown vault files (images, audio, video, PDFs, …) as published attachments or unpublished spans.',
	doc: `Built-in stage (Beta): renders \`![[file.ext]]\`, \`[[file.ext]]\`, \`![](file.ext)\` and
\`[text](file.ext)\` that point at non-Markdown vault files. Runs on MDAST (order 038),
after \`remark-block-ids\` (035) and before \`remark-obsidian-links\` (040), so
attachment references never reach that stage and overrides of it keep working.

\`context.resolveAttachment(linkpath)\` decides each link: \`null\` leaves it alone
(a note, an unresolved link, an external URL); \`{ published: false }\` renders
\`<span class="unpublished-link">\` with the file name; \`{ published: true }\` renders
the attachment (\`inline: true\` marks a PDF the profile shows inline). Only files in the note's attachment list (from Obsidian's
metadata cache) are ever \`published: true\`.

| Reference | Output |
|-----------|--------|
| image embed | \`<img class="cpn-attachment cpn-attachment-image" data-cpn-attachment alt loading="lazy">\`, \`\\|300\` / \`\\|300x200\` set width/height |
| audio embed | \`<audio class="cpn-attachment cpn-attachment-audio" controls preload="metadata" data-cpn-attachment>\` |
| video embed | \`<video class="cpn-attachment cpn-attachment-video" controls preload="metadata" data-cpn-attachment>\`, sized like images |
| PDF embed with **Show PDFs inline** on (\`inline: true\`) | \`<span class="cpn-attachment-pdf-embed">\` holding \`<iframe class="cpn-attachment cpn-attachment-pdf" data-cpn-attachment title loading="lazy">\` (sized like images) and the new-tab link below |
| other embed, any plain link, any embed in a heading | \`<a class="cpn-attachment cpn-attachment-file" data-cpn-attachment target="_blank" rel="noopener">\` |

🔗 **Coupling (site contract):** \`data-cpn-attachment="<sha256>/<fileName>"\` is the
object key relative to the note's access area. The HTML never holds an \`src\` or
\`href\` for an attachment: the published SPA builds
\`/<area>attachments/<sha256>/<fileName>\` for the area it loaded the note from, and
appends \`#<data-cpn-fragment>\` (e.g. \`page=3\` on a PDF link). The
\`cpn-attachment*\` classes are styled by the site.

**Known limitations:**
- A paragraph mixing an attachment embed with a note embed (\`![[pic.png]] ![[Note]]\`)
  has several children, so the note embed renders as an inline transclusion.
- Raw HTML (\`<img src="Media/x.png">\`, \`<audio src>\`, \`<a href>\`) and reference-style
  links (\`[ref]: Media/a.pdf\`) aren't in Obsidian's metadata cache and aren't
  visited here: they pass through as written, folder path included.
- A link Obsidian indexes that remark doesn't parse as one wikilink in one text
  node, or as one \`image\`/\`link\` node (e.g. \`![[my *draft* take.mp3]]\`, which
  remark splits at the emphasis), is uploaded but neither rendered nor obscured
  in the published \`raw\`.`,
	code: `// In scope: libs, context, app, utils — NO imports.
return [libs.remarkAttachments, {
  resolveAttachment: context.resolveAttachment,
}];`,
});
