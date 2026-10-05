/**
 * Rewrites links to archived Substack posts so they open in the local reader.
 *
 * Saved markdown still contains publication URLs such as
 * https://<subdomain>.substack.com/p/<slug>. When that slug exists under
 * content/<author>/posts/, the link target becomes /posts/<author>/posts/<slug>.
 * Posts that were not scraped stay on the original URL.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getContentPath } from '../server/paths';
import { joinSiteBase } from './local-content-images';

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

interface LocalPostLinkOptions {
  contentDirectory?: string;
  siteBase?: string;
}

const indexCache = new Map<string, Map<string, string>>();

/**
 * Map `hostname/p/<slug>` keys to local reader paths for every saved post.
 */
export function buildPublicationPostIndex(contentDirectory: string): Map<string, string> {
  const index = new Map<string, string>();
  if (!fs.existsSync(contentDirectory)) return index;

  for (const authorEntry of fs.readdirSync(contentDirectory, { withFileTypes: true })) {
    if (!authorEntry.isDirectory()) continue;
    collectAuthorPosts(contentDirectory, authorEntry.name, index);
  }
  return index;
}

/**
 * Return the local reader path for a publication post URL, or null when it is not archived.
 */
export function localReaderPathForHref(
  href: string,
  publicationIndex: Map<string, string>,
  siteBase = ''
): string | null {
  const publicationKey = publicationPostKey(href);
  if (!publicationKey) return null;
  const localPath = publicationIndex.get(publicationKey);
  if (!localPath) return null;
  return joinSiteBase(siteBase, localPath);
}

/**
 * Rehype plugin: point archived publication links at the local reader.
 */
export function rehypeLocalPostLinks(options: LocalPostLinkOptions = {}) {
  const contentDirectory = path.resolve(options.contentDirectory ?? getContentPath());
  const siteBase = options.siteBase ?? '';
  const publicationIndex = publicationPostIndex(contentDirectory);

  return function transformLocalPostLinks(tree: HastNode) {
    rewritePublicationLinks(tree, publicationIndex, siteBase, false);
  };
}

function publicationPostIndex(contentDirectory: string): Map<string, string> {
  const cachedIndex = indexCache.get(contentDirectory);
  if (cachedIndex) return cachedIndex;
  const publicationIndex = buildPublicationPostIndex(contentDirectory);
  indexCache.set(contentDirectory, publicationIndex);
  return publicationIndex;
}

function collectAuthorPosts(
  contentDirectory: string,
  authorDirectoryName: string,
  publicationIndex: Map<string, string>
) {
  const postsDirectory = path.join(contentDirectory, authorDirectoryName, 'posts');
  if (!fs.existsSync(postsDirectory)) return;

  for (const entry of fs.readdirSync(postsDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.mdx?$/i.test(entry.name)) continue;
    const markdownFilePath = path.join(postsDirectory, entry.name);
    const slug = entry.name.replace(/\.mdx?$/i, '');
    const localPath = `/posts/${authorDirectoryName}/posts/${encodePathSegment(slug)}`;
    const canonicalUrl = readCanonicalUrl(fs.readFileSync(markdownFilePath, 'utf8'));
    const canonicalKey = canonicalUrl ? publicationPostKey(canonicalUrl) : null;
    rememberPost(publicationIndex, canonicalKey, localPath);
    rememberPost(publicationIndex, `${authorDirectoryName}.substack.com/p/${slug}`, localPath);
  }
}

function rememberPost(
  publicationIndex: Map<string, string>,
  publicationKey: string | null,
  localPath: string
) {
  if (!publicationKey || publicationIndex.has(publicationKey)) return;
  publicationIndex.set(publicationKey, localPath);
}

function rewritePublicationLinks(
  node: HastNode,
  publicationIndex: Map<string, string>,
  siteBase: string,
  insideCode: boolean
) {
  const children = node.children;
  if (!children) return;

  const childIsCode = node.tagName === 'code' || node.tagName === 'pre';
  for (const child of children) {
    if (child.type !== 'element' || !child.tagName) continue;
    if (!insideCode && !childIsCode && child.tagName === 'a') {
      const href = stringProperty(child.properties?.href);
      const localPath = href ? localReaderPathForHref(href, publicationIndex, siteBase) : null;
      if (localPath && child.properties) {
        child.properties.href = localPath;
        replaceUrlText(child, href, localPath);
      }
    }
    rewritePublicationLinks(child, publicationIndex, siteBase, insideCode || childIsCode);
  }
}

function replaceUrlText(link: HastNode, originalHref: string, localPath: string) {
  const children = link.children ?? [];
  if (children.length === 0 || children.some((child) => child.type !== 'text')) return;

  const linkText = children
    .map((child) => child.value ?? '')
    .join('')
    .trim();
  const textKey = publicationPostKey(linkText);
  const hrefKey = publicationPostKey(originalHref);
  if (!textKey || textKey !== hrefKey) return;

  link.children = [{ type: 'text', value: localPath }];
}

function publicationPostKey(href: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const slugMatch = parsed.pathname.match(/^\/p\/([^/]+)/);
  if (!slugMatch) return null;
  let slug = slugMatch[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  return `${hostname}/p/${slug}`;
}

function readCanonicalUrl(markdown: string): string | null {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const canonicalLine = frontmatter?.[1].match(/^canonical_url:\s*["']?(\S+?)["']?\s*$/m);
  return canonicalLine?.[1] ?? null;
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function stringProperty(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
