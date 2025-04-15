import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { optimize } from 'svgo';
import { DOMParser, XMLSerializer } from 'xmldom';

async function run() {
  try {
    // Get inputs from action
    const layoutInput = core.getInput('layout', { required: true });
    const assetsInput = core.getInput('assets', { required: false }) || 'images/*.svg';
    const token = core.getInput('token', { required: true });
    
    // Parse layout JSON
    let layout;
    try {
      layout = JSON.parse(layoutInput);
      if (!Array.isArray(layout)) {
        throw new Error('Layout must be a JSON array');
      }
    } catch (error) {
      core.setFailed(`Invalid layout JSON: ${error.message}`);
      return;
    }
    
    // Initialize parser and serializer
    const parser = new DOMParser();
    const serializer = new XMLSerializer();
    
    // Create a map of asset files for faster lookups
    const assetMap = new Map();
    const assetPatterns = assetsInput.split(',').map(pattern => pattern.trim());
    
    for (const pattern of assetPatterns) {
      const globber = await glob.create(pattern);
      const files = await globber.glob();
      
      for (const file of files) {
        const relativePath = path.relative(process.cwd(), file);
        assetMap.set(relativePath, file);
      }
    }
    
    // Set fixed dimensions for the background and SVG canvas
    const minX = -150;
    const maxX = 1050;
    const minY = 0;
    const maxY = 600;
    
    const svgWidth = maxX - minX;
    const svgHeight = maxY - minY;
    
    // Create the root SVG with fixed dimensions
    const rootSvg = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${svgWidth}" height="${svgHeight}" viewBox="${minX} ${minY} ${svgWidth} ${svgHeight}"></svg>`,
      'image/svg+xml'
    );
    
    const rootElement = rootSvg.documentElement;
    
    // Create a style element to store all CSS
    const styleElement = rootSvg.createElement('style');
    let cssContent = '';
    
    // Process each layout item
    for (const item of layout) {
      try {
        let content;
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          const response = await fetch(item.url);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          
          // We want the raw content for all types to inline properly
          content = await response.text();
        } else if (item.url.startsWith('blob:')) {
          // Local file - read from disk (keeping the blob: prefix for compatibility)
          const filePath = item.url.substring(5); // Remove 'blob:' prefix
          const imagePath = path.join('images', filePath);
          
          core.info(`Reading local file: ${imagePath}`);
          
          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}`);
          }
          
          const fileContent = await fs.readFile(assetMap.get(imagePath));
          content = fileContent.toString('utf8');
        } else if (item.url.startsWith('images/')) {
          // Direct path to images directory
          const imagePath = item.url;
          
          core.info(`Reading local file: ${imagePath}`);
          
          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}`);
          }
          
          const fileContent = await fs.readFile(assetMap.get(imagePath));
          content = fileContent.toString('utf8');
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
        // For SVG content, we want to inline it properly
        if (item.type === 'svg') {
          // Parse SVG content
          const svgDoc = parser.parseFromString(content, 'image/svg+xml');
          const svgElement = svgDoc.documentElement;
          
          // Create a group to position and scale the SVG
          const group = rootSvg.createElement('g');
          group.setAttribute('id', `item-${item.id}`);
          
          // Get SVG dimensions
          let svgWidth, svgHeight;
          
          if (svgElement.hasAttribute('width') && svgElement.hasAttribute('height')) {
            svgWidth = parseFloat(svgElement.getAttribute('width'));
            svgHeight = parseFloat(svgElement.getAttribute('height'));
          } else if (svgElement.hasAttribute('viewBox')) {
            const viewBox = svgElement.getAttribute('viewBox').split(/[\s,]+/);
            svgWidth = parseFloat(viewBox[2]);
            svgHeight = parseFloat(viewBox[3]);
          } else {
            // Default dimensions if not specified
            svgWidth = item.width;
            svgHeight = item.height;
          }
          
          // Apply translation and scaling through transform attribute
          const scaleX = item.width / svgWidth;
          const scaleY = item.height / svgHeight;
          group.setAttribute('transform', `translate(${item.x}, ${item.y}) scale(${scaleX}, ${scaleY})`);
          
          // Extract and collect CSS styles
          const styleElements = svgElement.getElementsByTagName('style');
          if (styleElements.length > 0) {
            for (let i = 0; i < styleElements.length; i++) {
              const style = styleElements[i];
              let styleCss = style.textContent || '';
              
              // Prefix all selectors with the group ID to avoid conflicts
              styleCss = prefixCssSelectors(styleCss, `#item-${item.id}`);
              
              cssContent += styleCss + '\n';
            }
          }
          
          // Handle inline styles on elements
          const processNode = (node) => {
            if (node.nodeType === 1) { // Element node
              if (node.hasAttribute('style')) {
                // Keep inline styles as they are
              }
              
              if (node.hasAttribute('id')) {
                // Make IDs unique by prefixing them with the item ID
                const originalId = node.getAttribute('id');
                node.setAttribute('id', `${item.id}-${originalId}`);
              }
              
              // Process child nodes
              for (let i = 0; i < node.childNodes.length; i++) {
                processNode(node.childNodes[i]);
              }
            }
          };
          
          // Extract and copy all defs (important for animations, gradients, etc.)
          const defsElements = svgElement.getElementsByTagName('defs');
          if (defsElements.length > 0) {
            const mergedDefs = rootSvg.createElement('defs');
            for (let i = 0; i < defsElements.length; i++) {
              const defs = defsElements[i];
              // Process defs to make IDs unique
              processNode(defs);
              
              // Copy all child nodes from defs
              for (let j = 0; j < defs.childNodes.length; j++) {
                mergedDefs.appendChild(defs.childNodes[j].cloneNode(true));
              }
            }
            
            if (mergedDefs.hasChildNodes()) {
              group.appendChild(mergedDefs);
            }
          }
          
          // Copy all child nodes except style and defs
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            const nodeName = node.nodeName.toLowerCase();
            
            if (nodeName !== 'style' && nodeName !== 'defs') {
              // Process the node to make IDs unique
              processNode(node);
              group.appendChild(node.cloneNode(true));
            }
          }
          
          rootElement.appendChild(group);
        } else if (item.type === 'image' || item.type.match(/^(png|jpg|jpeg|gif)$/)) {
          // For binary images, we need to convert them to data URIs and inline them
          
          // If the content is already an SVG string, convert to data URI
          if (content.trim().startsWith('<svg')) {
            // The content is already SVG, so wrap it in a g element
            const imageGroup = rootSvg.createElement('g');
            imageGroup.setAttribute('transform', `translate(${item.x}, ${item.y})`);
            
            const svgDoc = parser.parseFromString(content, 'image/svg+xml');
            const svgElement = svgDoc.documentElement;
            
            // Copy the SVG content into the group
            while (svgElement.firstChild) {
              imageGroup.appendChild(svgElement.firstChild);
            }
            
            rootElement.appendChild(imageGroup);
          } else {
            // For binary image content that we got as text, we need to re-fetch it as binary
            const imageUrl = item.url;
            let base64Content;
            
            if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
              const response = await fetch(imageUrl);
              const buffer = await response.arrayBuffer();
              base64Content = Buffer.from(buffer).toString('base64');
            } else if (imageUrl.startsWith('blob:') || imageUrl.startsWith('images/')) {
              const filePath = imageUrl.startsWith('blob:') 
                ? path.join('images', imageUrl.substring(5))
                : imageUrl;
              
              if (!assetMap.has(filePath)) {
                throw new Error(`Local asset not found: ${filePath}`);
              }
              
              const fileContent = await fs.readFile(assetMap.get(filePath));
              base64Content = fileContent.toString('base64');
            }
            
            // Since we can't use href, we'll use a foreignObject with an embedded img
            const foreignObject = rootSvg.createElement('foreignObject');
            foreignObject.setAttribute('x', item.x);
            foreignObject.setAttribute('y', item.y);
            foreignObject.setAttribute('width', item.width);
            foreignObject.setAttribute('height', item.height);
            
            const svgImage = rootSvg.createElement('svg');
            svgImage.setAttribute('width', '100%');
            svgImage.setAttribute('height', '100%');
            svgImage.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            
            // Create an SVG image element that uses base64 encoded data
            // We have to use this approach since we can't use href
            const imageElement = rootSvg.createElement('image');
            imageElement.setAttribute('x', '0');
            imageElement.setAttribute('y', '0');
            imageElement.setAttribute('width', '100%');
            imageElement.setAttribute('height', '100%');
            
            // Use a data URI without 'href'
            const mimeType = getMimeType(item.type);
            imageElement.setAttribute('xlink:href', `data:${mimeType};base64,${base64Content}`);
            
            svgImage.appendChild(imageElement);
            foreignObject.appendChild(svgImage);
            rootElement.appendChild(foreignObject);
          }
        }
      } catch (error) {
        core.warning(`Error processing item ${JSON.stringify(item)}: ${error.message}`);
      }
    }
    
    // Add the collected CSS styles to the style element
    if (cssContent) {
      styleElement.textContent = cssContent;
      rootElement.insertBefore(styleElement, rootElement.firstChild);
    }
    
    // Serialize the merged SVG
    const mergedSvgString = serializer.serializeToString(rootSvg);
    
    // Write merged SVG to temporary file
    await fs.writeFile('merged.svg', mergedSvgString);
    
    // Optimize SVG with SVGO but preserve animations
    core.info('Optimizing SVG with SVGO...');
    const optimizedSvg = optimize(mergedSvgString, {
      plugins: [
        {
          name: 'preset-default',
          params: {
            overrides: {
              // Disable plugins that might break animations or layout
              removeViewBox: false,
              removeHiddenElems: false,
              removeUselessDefs: false,
              convertShapeToPath: false,
              moveElemsAttrsToGroup: false,
              moveGroupAttrsToElems: false,
              collapseGroups: false,
              convertPathData: false,
              removeEmptyAttrs: false,
              removeEmptyContainers: false,
              mergePaths: false,
              removeUnknownsAndDefaults: false,
              removeNonInheritableGroupAttrs: false,
              // Critical for animations
              inlineStyles: false,
              minifyStyles: false,
              cleanupIDs: false
            },
          },
        },
      ],
    });
    
    // Write optimized SVG to README.svg
    await fs.writeFile('README.svg', optimizedSvg.data);
    
    // Configure git user
    await exec.exec('git', ['config', 'user.name', 'GitHub Action']);
    await exec.exec('git', ['config', 'user.email', 'action@github.com']);
    
    // Check if there are changes to commit
    const { exitCode } = await exec.exec('git', ['diff', '--quiet', 'README.svg'], { ignoreReturnCode: true });
    
    if (exitCode !== 0) {
      // Changes detected, commit and push
      await exec.exec('git', ['add', 'README.svg']);
      await exec.exec('git', ['commit', '-m', 'ci: update merged profile SVG']);
      
      // Set up the remote repository
      const repository = `https://x-access-token:${token}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
      await exec.exec('git', ['push', repository]);
      
      core.info('Successfully committed and pushed updated README.svg');
    } else {
      core.info('No changes to commit');
    }
    
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

// Helper function to prefix CSS selectors with a namespace
function prefixCssSelectors(css, prefix) {
  if (!css) return '';
  
  // Simple CSS parser to prefix selectors
  // This is a basic implementation and may not cover all CSS cases
  return css.replace(/([^\r\n,{}]+)(,(?=[^}]*{)|\s*{)/g, function(match, selector, delimiter) {
    // Don't prefix @-rules like @keyframes, @media, etc.
    if (selector.trim().startsWith('@')) {
      return match;
    }
    
    // Split selectors and prefix each one
    const selectors = selector.split(',');
    const prefixedSelectors = selectors.map(s => {
      const trimmed = s.trim();
      
      // Handle :root selector
      if (trimmed === ':root') {
        return prefix;
      }
      
      // Handle special cases
      if (trimmed.includes('@keyframes')) {
        return trimmed;
      }
      
      // Handle descendant selectors
      if (trimmed.startsWith('>') || trimmed.startsWith('+') || trimmed.startsWith('~')) {
        return `${prefix} ${trimmed}`;
      }
      
      return `${prefix} ${trimmed}`;
    });
    
    return prefixedSelectors.join(', ') + delimiter;
  });
}

// Helper function to get MIME type for different image formats
function getMimeType(type) {
  switch (type.toLowerCase()) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    case 'image': 
    default: return 'image/png';
  }
}

run();