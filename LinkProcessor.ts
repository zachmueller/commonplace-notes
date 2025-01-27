import { App, TFile } from 'obsidian';
import { PathUtils } from './utils/path';
import path from 'path';

interface LinkData {
  links: {
    internal: Array<{
      path: string;
      alias?: string;
      slug: string;
    }>;
    external: Array<{
      url: string;
      alias?: string;
    }>;
  };
  embeds: Array<{
    path: string;
    type: 'image' | 'audio' | 'video' | 'pdf' | 'other';
    slug: string;
  }>;
}

export class LinkProcessor {
  constructor(private app: App) {}

  getLinkData(file: TFile): LinkData {
    const cache = this.app.metadataCache.getFileCache(file);
    const result: LinkData = {
      links: {
        internal: [],
        external: []
      },
      embeds: []
    };

    // Process links from cache
    if (cache?.links) {
      for (const link of cache.links) {
        const resolved = this.app.metadataCache.resolvedLinks[file.path]?.[link.link];
        
        if (resolved) {
          // Internal link - get the actual file path
          const targetFile = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
          if (targetFile) {
            const slug = PathUtils.slugifyFilePath(targetFile.path);
            result.links.internal.push({
              path: targetFile.path,
              alias: link.displayText,
              slug
            });
          }
        } else if (this.isAbsoluteUrl(link.link)) {
          // External link
          result.links.external.push({
            url: link.link,
            alias: link.displayText
          });
        }
      }
    }

    // Process embeds from cache
    if (cache?.embeds) {
      for (const embed of cache.embeds) {
        const targetFile = this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
        if (targetFile) {
          const ext = path.extname(targetFile.path).toLowerCase();
          const type = this.getEmbedType(ext);
          const slug = PathUtils.slugifyFilePath(targetFile.path);
          
          result.embeds.push({
            path: targetFile.path,
            type,
            slug
          });
        }
      }
    }

    return result;
  }

  private isAbsoluteUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  private getEmbedType(extension: string): 'image' | 'audio' | 'video' | 'pdf' | 'other' {
    const mediaTypes = {
      image: ['.png', '.jpg', '.jpeg', '.gif', '.svg'],
      audio: ['.mp3', '.wav', '.ogg'],
      video: ['.mp4', '.webm'],
      pdf: ['.pdf']
    };

    for (const [type, exts] of Object.entries(mediaTypes)) {
      if (exts.includes(extension)) {
        return type as any;
      }
    }

    return 'other';
  }
}