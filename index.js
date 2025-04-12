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
    
    // Create root SVG document
    // We'll determine the dimensions based on the layout items
    let minX = 0;
    let minY = 0;
    let maxWidth = 0;
    let maxHeight = 0;
    
    // Process each layout item to find dimensions
    layout.forEach(item => {
      if (item.x < minX) minX = item.x;
      if (item.y < minY) minY = item.y;
      
      const itemRight = item.x + item.width;
      const itemBottom = item.y + item.height;
      
      if (itemRight > maxWidth) maxWidth = itemRight;
      if (itemBottom > maxHeight) maxHeight = itemBottom;
    });
    
    // Set fixed dimensions for background
    const bgMinX = -150;
    const bgMaxX = 850;
    const bgMinY = 0;
    const bgMaxY = 550;
    
    // Adjust canvas dimensions to include all content and background
    const canvasMinX = Math.min(minX, bgMinX);
    const canvasMaxX = Math.max(maxWidth, bgMaxX);
    const canvasMinY = Math.min(minY, bgMinY);
    const canvasMaxY = Math.max(maxHeight, bgMaxY);
    
    const canvasWidth = canvasMaxX - canvasMinX;
    const canvasHeight = canvasMaxY - canvasMinY;
    
    // Create the root SVG with calculated dimensions
    const rootSvg = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="${canvasMinX} ${canvasMinY} ${canvasWidth} ${canvasHeight}"></svg>`,
      'image/svg+xml'
    );
    
    const rootElement = rootSvg.documentElement;
    
    // Add white background as the first element
    const backgroundRect = rootSvg.createElement('rect');
    backgroundRect.setAttribute('x', bgMinX.toString());
    backgroundRect.setAttribute('y', bgMinY.toString());
    backgroundRect.setAttribute('width', (bgMaxX - bgMinX).toString());
    backgroundRect.setAttribute('height', (bgMaxY - bgMinY).toString());
    backgroundRect.setAttribute('fill', 'white');
    rootElement.appendChild(backgroundRect);
    
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
          
          if (item.type === 'svg') {
            content = await response.text();
          } else {
            // For images, we'll need the binary data as base64
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = response.headers.get('content-type') || 'image/png';
            content = `data:${mimeType};base64,${base64}`;
          }
        } else if (item.url.startsWith('blob:')) {
          // Local file - read from disk (keeping the blob: prefix for compatibility)
          const filePath = item.url.substring(5); // Remove 'blob:' prefix
          const imagePath = path.join('images', filePath);
          
          core.info(`Reading local file: ${imagePath}`);
          
          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}`);
          }
          
          const fileContent = await fs.readFile(assetMap.get(imagePath));
          
          if (item.type === 'svg') {
            content = fileContent.toString('utf8');
          } else {
            // For images, convert to base64
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            content = `data:${mimeType};base64,${base64}`;
          }
        } else if (item.url.startsWith('images/')) {
          // Direct path to images directory
          const imagePath = item.url;
          
          core.info(`Reading local file: ${imagePath}`);
          
          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}`);
          }
          
          const fileContent = await fs.readFile(assetMap.get(imagePath));
          
          if (item.type === 'svg') {
            content = fileContent.toString('utf8');
          } else {
            // For images, convert to base64
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            content = `data:${mimeType};base64,${base64}`;
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
        // Process content based on type
        if (item.type === 'svg') {
          // Parse SVG content
          const svgDoc = parser.parseFromString(content, 'image/svg+xml');
          const svgElement = svgDoc.documentElement;
          
          // Create a group to position and scale the SVG
          const group = rootSvg.createElement('g');
          group.setAttribute('transform', `translate(${item.x}, ${item.y})`);
          
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
          
          // Apply scale if necessary
          if (svgWidth !== item.width || svgHeight !== item.height) {
            const scaleX = item.width / svgWidth;
            const scaleY = item.height / svgHeight;
            group.setAttribute('transform', `translate(${item.x}, ${item.y}) scale(${scaleX}, ${scaleY})`);
          }
          
          // Preserve animations and other dynamic elements by copying the entire SVG content
          // Instead of copying each child node individually, we extract all child nodes
          // AND copy important attributes from the root SVG element
          
          // Copy necessary attributes from source SVG
          // These are important for animations, CSS, etc.
          const attributesToCopy = ['style', 'class', 'xmlns:xlink'];
          attributesToCopy.forEach(attr => {
            if (svgElement.hasAttribute(attr)) {
              group.setAttribute(attr, svgElement.getAttribute(attr));
            }
          });
          
          // Extract and copy all defs (important for animations, gradients, etc.)
          const defsElements = svgElement.getElementsByTagName('defs');
          if (defsElements.length > 0) {
            for (let i = 0; i < defsElements.length; i++) {
              const defs = defsElements[i];
              const clonedDefs = defs.cloneNode(true);
              group.appendChild(clonedDefs);
            }
          }
          
          // Copy all child nodes to maintain structure and animations
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            // Skip defs nodes as they have already been processed
            if (node.nodeName !== 'defs') {
              group.appendChild(node.cloneNode(true));
            }
          }
          
          rootElement.appendChild(group);
        } else if (item.type === 'image' || item.type.match(/^(png|jpg|jpeg|gif)$/)) {
          // Create image element
          const imageElement = rootSvg.createElement('image');
          imageElement.setAttribute('x', item.x);
          imageElement.setAttribute('y', item.y);
          imageElement.setAttribute('width', item.width);
          imageElement.setAttribute('height', item.height);
          imageElement.setAttribute('href', content);
          
          rootElement.appendChild(imageElement);
        }
      } catch (error) {
        core.warning(`Error processing item ${JSON.stringify(item)}: ${error.message}`);
      }
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

run();