/**
 * Serves scraped article images and turns local image links into pictures.
 *
 * Scraped posts store files at content/<author>/images/<slug>/<file> and refer to
 * them as ../images/... from the markdown file. Post pages live one directory
 * deeper (/posts/<author>/posts/<slug>/), so those relative URLs 404, and most
 * of the references are links rather than images. This publishes the files at
 * /images/<author>/... and rewrites local and remote image links into <img> tags.
 */

import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import type { Plugin } from 'vite';
import { getContentPath } from '../server/paths';

const IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);
const REMOTE_IMAGE_FORMATS = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

interface LocalContentImage {
  filePath: string;
  publicUrl: string;
}

interface LocalContentImageOptions {
  contentDirectory?: string;
  siteBase?: string;
}

/**
 * Collapse a configured site base to a prefix with no trailing slash.
 * Root bases (`''` and `'/'`) become an empty prefix.
 */
export function normalizeSiteBase(siteBase: string): string {
  if (!siteBase || siteBase === '/') return '';
  return `/${siteBase.replace(/^\/+|\/+$/g, '')}`;
}

/**
 * Prefix a root-absolute pathname with the configured site base.
 */
export function joinSiteBase(siteBase: string, pathname: string): string {
  const normalizedBase = normalizeSiteBase(siteBase);
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${normalizedBase}${normalizedPath}`;
}

/**
 * Resolve a markdown image or link target to a scraped content image.
 *
 * Returns null when the target is remote, escapes the author images directory,
 * or is not an image file.
 */
export function resolveLocalContentImage(
  markdownFilePath: string,
  href: string,
  contentDirectory: string,
  siteBase = ''
): LocalContentImage | null {
  const decodedHref = decodeImageHref(href);
  if (!decodedHref || isRemoteOrRootHref(decodedHref)) return null;

  const resolvedContentDirectory = path.resolve(contentDirectory);
  const imageFilePath = path.resolve(path.dirname(filesystemPath(markdownFilePath)), decodedHref);
  const relativePath = path.relative(resolvedContentDirectory, imageFilePath);
  const pathSegments = relativePath.split(path.sep);
  if (pathSegments.length < 3 || pathSegments[1] !== 'images') return null;
  if (pathSegments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    return null;

  const extension = path.extname(pathSegments[pathSegments.length - 1]).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) return null;

  const authorDirectoryName = pathSegments[0];
  const imageRelativePath = pathSegments.slice(2).join('/');
  const publicPath = `/images/${encodePathSegments(authorDirectoryName)}/${encodePathSegments(imageRelativePath)}`;
  return {
    filePath: imageFilePath,
    publicUrl: joinSiteBase(siteBase, publicPath),
  };
}

/**
 * Detect a remote URL that serves an image even when the path has no file extension.
 *
 * Unsplash photo URLs, for example, end in a query such as `fm=jpg` rather than `.jpg`.
 */
export function isRemoteImageUrl(href: string): boolean {
  let imageUrl: URL;
  try {
    imageUrl = new URL(href);
  } catch {
    return false;
  }
  if (imageUrl.protocol !== 'http:' && imageUrl.protocol !== 'https:') return false;

  let pathname = imageUrl.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const extension = path.posix.extname(pathname).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return true;

  for (const parameterName of ['fm', 'format', 'ext']) {
    const format = imageUrl.searchParams.get(parameterName)?.toLowerCase().replace(/^\./, '');
    if (format && REMOTE_IMAGE_FORMATS.has(format)) return true;
  }

  const hostname = imageUrl.hostname.toLowerCase();
  if (hostname === 'images.unsplash.com' && pathname.startsWith('/photo-')) return true;
  if (hostname === 'substackcdn.com' && pathname.startsWith('/image/')) return true;
  return false;
}

/**
 * Derive alt text from a scraped image link, dropping converter noise such as "SVG Image".
 */
export function captionFromLinkText(linkText: string): {
  altText: string;
  captionText: string | null;
} {
  const captionText = linkText
    .replace(/\s+/g, ' ')
    .replace(/\s*SVG Image/g, '')
    .trim();
  if (!captionText || /^image$/i.test(captionText)) {
    return { altText: 'image', captionText: null };
  }
  return { altText: captionText, captionText };
}

/**
 * Rehype plugin: replace local image links with img elements served from /images/.
 */
export function rehypeLocalContentImages(options: LocalContentImageOptions = {}) {
  const contentDirectory = options.contentDirectory ?? getContentPath();
  const siteBase = options.siteBase ?? '';

  return function transformLocalContentImages(tree: HastNode, file: { path?: string }) {
    if (!file.path) return;
    rewriteLocalImageLinks(tree, file.path, contentDirectory, siteBase);
  };
}

/**
 * Hardlink scraped images into the static build at /images/<author>/.
 * Falls back to a copy when the output directory is on another filesystem.
 *
 * @returns Number of image files published.
 */
export function publishContentImages(contentDirectory: string, outputDirectory: string): number {
  if (!fs.existsSync(contentDirectory)) return 0;

  let publishedFileCount = 0;
  for (const contentEntry of fs.readdirSync(contentDirectory, { withFileTypes: true })) {
    if (!contentEntry.isDirectory()) continue;
    const sourceImagesDirectory = path.join(contentDirectory, contentEntry.name, 'images');
    if (!fs.existsSync(sourceImagesDirectory) || !fs.statSync(sourceImagesDirectory).isDirectory())
      continue;

    const destinationImagesDirectory = path.join(outputDirectory, 'images', contentEntry.name);
    fs.rmSync(destinationImagesDirectory, { recursive: true, force: true });
    publishedFileCount += linkOrCopyDirectory(sourceImagesDirectory, destinationImagesDirectory);
  }
  return publishedFileCount;
}

/**
 * Map a site request pathname to a scraped image file, or null when it is not one.
 */
export function contentImageFileFromPath(
  requestPathname: string,
  contentDirectory: string,
  siteBase = ''
): string | null {
  let pathname = requestPathname;
  try {
    pathname = decodeURIComponent(requestPathname);
  } catch {
    return null;
  }

  const normalizedBase = normalizeSiteBase(siteBase);
  if (normalizedBase) {
    if (pathname === normalizedBase) return null;
    if (!pathname.startsWith(`${normalizedBase}/`)) return null;
    pathname = pathname.slice(normalizedBase.length);
  }

  const match = pathname.match(/^\/images\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const authorDirectoryName = match[1];
  const imageRelativePath = match[2];
  const relativeSegments = [authorDirectoryName, ...imageRelativePath.split('/')];
  if (relativeSegments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    return null;

  const extension = path.extname(relativeSegments[relativeSegments.length - 1]).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) return null;

  const imagesDirectory = path.resolve(contentDirectory, authorDirectoryName, 'images');
  const imageFilePath = path.resolve(imagesDirectory, ...imageRelativePath.split('/'));
  const relativeToImages = path.relative(imagesDirectory, imageFilePath);
  if (relativeToImages.startsWith('..') || path.isAbsolute(relativeToImages)) return null;
  if (!fs.existsSync(imageFilePath) || !fs.statSync(imageFilePath).isFile()) return null;
  return imageFilePath;
}

/**
 * Astro integration that publishes scraped images for preview and serves them in dev.
 */
export function localContentImagesIntegration(): AstroIntegration {
  const contentDirectory = getContentPath();
  return {
    name: 'local-content-images',
    hooks: {
      'astro:config:setup': ({ updateConfig, config }) => {
        updateConfig({
          vite: {
            plugins: [localContentImagesDevPlugin(contentDirectory, config.base)],
          },
        });
      },
      'astro:build:done': ({ dir, logger }) => {
        const publishedFileCount = publishContentImages(contentDirectory, fileURLToPath(dir));
        logger.info(`Published ${publishedFileCount} local article images`);
      },
    },
  };
}

function localContentImagesDevPlugin(contentDirectory: string, siteBase: string): Plugin {
  const serveLocalContentImage = (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void
  ) => {
    const requestPathname = request.url ? new URL(request.url, 'http://localhost').pathname : '';
    const imageFilePath = contentImageFileFromPath(requestPathname, contentDirectory, siteBase);
    if (!imageFilePath || (request.method !== 'GET' && request.method !== 'HEAD')) {
      next();
      return;
    }

    const extension = path.extname(imageFilePath).toLowerCase();
    const fileStats = fs.statSync(imageFilePath);
    response.statusCode = 200;
    response.setHeader(
      'Content-Type',
      IMAGE_CONTENT_TYPES[extension] ?? 'application/octet-stream'
    );
    response.setHeader('Content-Length', fileStats.size);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(imageFilePath).pipe(response);
  };

  return {
    name: 'local-content-images',
    configureServer(server) {
      server.middlewares.use(serveLocalContentImage);
    },
    configurePreviewServer(server) {
      return () => {
        server.middlewares.use(serveLocalContentImage);
      };
    },
  };
}

function rewriteLocalImageLinks(
  node: HastNode,
  markdownFilePath: string,
  contentDirectory: string,
  siteBase: string
) {
  const children = node.children;
  if (!children) return;

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.type !== 'element') continue;

    if (
      child.tagName === 'a' &&
      node.tagName !== 'code' &&
      node.tagName !== 'pre' &&
      isTextOnly(child)
    ) {
      const href = stringProperty(child.properties?.href);
      const resolvedImage = href
        ? resolveLocalContentImage(markdownFilePath, href, contentDirectory, siteBase)
        : null;
      const remoteImageUrl = href && isRemoteImageUrl(href) ? href : null;
      const imageSource =
        resolvedImage?.filePath && fs.existsSync(resolvedImage.filePath)
          ? resolvedImage.publicUrl
          : remoteImageUrl;
      if (imageSource) {
        const { altText, captionText } = captionFromLinkText(elementText(child));
        const replacement: HastNode[] = [imageElement(imageSource, altText)];
        if (captionText) replacement.push(captionElement(captionText));
        children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
        continue;
      }
    }

    rewriteLocalImageLinks(child, markdownFilePath, contentDirectory, siteBase);
  }
}

function imageElement(publicUrl: string, altText: string): HastNode {
  return {
    type: 'element',
    tagName: 'img',
    properties: {
      src: publicUrl,
      alt: altText,
      loading: 'lazy',
      decoding: 'async',
    },
    children: [],
  };
}

function captionElement(captionText: string): HastNode {
  return {
    type: 'element',
    tagName: 'em',
    properties: {},
    children: [{ type: 'text', value: captionText }],
  };
}

function isTextOnly(node: HastNode): boolean {
  const children = node.children ?? [];
  return children.length > 0 && children.every((child) => child.type === 'text');
}

function elementText(node: HastNode): string {
  return (node.children ?? []).map((child) => child.value ?? '').join('');
}

function stringProperty(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function filesystemPath(filePath: string): string {
  return filePath.startsWith('file:') ? fileURLToPath(filePath) : filePath;
}

function decodeImageHref(href: string): string | null {
  const withoutSuffix = href.split(/[?#]/)[0]?.trim() ?? '';
  if (!withoutSuffix) return null;
  try {
    return decodeURI(withoutSuffix);
  } catch {
    return null;
  }
}

function isRemoteOrRootHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('/');
}

function encodePathSegments(relativePath: string): string {
  return relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function linkOrCopyDirectory(sourceDirectory: string, destinationDirectory: string): number {
  fs.mkdirSync(destinationDirectory, { recursive: true });
  let linkedFileCount = 0;
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    if (entry.isDirectory()) {
      linkedFileCount += linkOrCopyDirectory(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    linkOrCopyFile(sourcePath, destinationPath);
    linkedFileCount += 1;
  }
  return linkedFileCount;
}

function linkOrCopyFile(sourceFilePath: string, destinationFilePath: string) {
  try {
    fs.linkSync(sourceFilePath, destinationFilePath);
  } catch (error) {
    const errorCode = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (errorCode === 'EEXIST') return;
    fs.copyFileSync(sourceFilePath, destinationFilePath);
  }
}
