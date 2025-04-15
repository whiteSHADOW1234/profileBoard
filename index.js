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
    
    // Set fixed dimensions for the viewBox as requested
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
    
    // Process each layout item
    for (const item of layout) {
      try {
        let svgContent;
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          const response = await fetch(item.url);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          
          // For SVG type, we want the raw SVG content
          if (item.type === 'svg') {
            svgContent = await response.text();
          } else {
            // For images, we'll need to create an SVG image element with the source URL
            // This allows animations in external SVGs to work properly
            const mimeType = response.headers.get('content-type') || 'image/png';
            
            if (mimeType.includes('svg')) {
              // If it's actually an SVG despite being marked as image
              svgContent = await response.text();
            } else {
              // Create an SVG image element for non-SVG images
              svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${item.width}" height="${item.height}">
                <image x="0" y="0" width="${item.width}" height="${item.height}" href="${item.url}" />
              </svg>`;
            }
          }
        } else if (item.url.startsWith('blob:')) {
          // Local file - read from disk
          const filePath = item.url.substring(5); // Remove 'blob:' prefix
          const imagePath = path.join('images', filePath);
          
          core.info(`Reading local file: ${imagePath}`);
          
          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}`);
          }
          
          const fileContent = await fs.readFile(assetMap.get(imagePath));
          
          if (item.type === 'svg') {
            svgContent = fileContent.toString('utf8');
          } else {
            // For non-SVG images, create an SVG wrapper with a base64 encoded image
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${item.width}" height="${item.height}">
              <image x="0" y="0" width="100%" height="100%" href="data:${mimeType};base64,${base64}" />
            </svg>`;
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
            svgContent = fileContent.toString('utf8');
          } else {
            // For non-SVG images, create an SVG wrapper with a base64 encoded image
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${item.width}" height="${item.height}">
              <image x="0" y="0" width="100%" height="100%" href="data:${mimeType};base64,${base64}" />
            </svg>`;
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
        // Parse the SVG content
        const svgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
        const svgElement = svgDoc.documentElement;
        
        // Create a group to contain the SVG content
        const group = rootSvg.createElement('g');
        
        // Get SVG dimensions from the source
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
        
        // Apply transformation for positioning and scaling
        const scaleX = item.width / svgWidth;
        const scaleY = item.height / svgHeight;
        group.setAttribute('transform', `translate(${item.x}, ${item.y}) scale(${scaleX}, ${scaleY})`);
        
        // Copy important attributes from the source SVG that might affect animations
        // These namespaces and attributes are crucial for animations
        const criticalAttributes = [
          'xmlns', 'xmlns:svg', 'xmlns:xlink', 'xmlns:html', 'style', 'class', 
          'version', 'baseProfile', 'xml:space', 'preserveAspectRatio'
        ];
        
        criticalAttributes.forEach(attr => {
          if (svgElement.hasAttribute(attr)) {
            // Don't copy xmlns to avoid duplicates in the group
            if (!attr.startsWith('xmlns:') && attr !== 'xmlns') {
              group.setAttribute(attr, svgElement.getAttribute(attr));
            }
          }
        });
        
        // Process <defs> elements first (important for animations, gradients, filters)
        const defsElements = svgElement.getElementsByTagName('defs');
        const processedDefs = new Set();
        
        if (defsElements.length > 0) {
          // Create a new defs element in the root SVG if it doesn't exist
          let rootDefs = rootSvg.getElementsByTagName('defs')[0];
          if (!rootDefs) {
            rootDefs = rootSvg.createElement('defs');
            rootElement.appendChild(rootDefs);
          }
          
          // Process each defs element from the source SVG
          for (let i = 0; i < defsElements.length; i++) {
            const defsElement = defsElements[i];
            
            // Copy all child nodes from defs
            for (let j = 0; j < defsElement.childNodes.length; j++) {
              const defsChild = defsElement.childNodes[j];
              
              // Skip text nodes and comments
              if (defsChild.nodeType !== 1) continue;
              
              // Check for ID attribute to avoid duplicates
              const id = defsChild.getAttribute('id');
              if (id && !processedDefs.has(id)) {
                processedDefs.add(id);
                rootDefs.appendChild(defsChild.cloneNode(true));
              } else if (!id) {
                rootDefs.appendChild(defsChild.cloneNode(true));
              }
            }
          }
        }
        
        // Copy all child nodes from the source SVG to our group
        for (let i = 0; i < svgElement.childNodes.length; i++) {
          const node = svgElement.childNodes[i];
          
          // Skip defs as we've already processed them
          if (node.nodeName === 'defs') continue;
          
          // Skip XML processing instructions and DOCTYPE
          if (node.nodeType !== 1) continue;
          
          // Clone and append other elements
          group.appendChild(node.cloneNode(true));
        }
        
        // Add the group to the root SVG
        rootElement.appendChild(group);
        
      } catch (error) {
        core.warning(`Error processing item ${JSON.stringify(item)}: ${error.message}`);
        core.debug(error.stack);
      }
    }
    
    // Serialize the merged SVG
    let mergedSvgString = serializer.serializeToString(rootSvg);
    
    // Fix potential XML serialization issues for CDATA sections
    // This ensures script elements and style elements with CDATA work properly
    mergedSvgString = mergedSvgString
      .replace(/<!\[CDATA\[/g, '<![CDATA[')
      .replace(/\]\]>/g, ']]>')
      .replace(/&amp;/g, '&')
      .replace(/&lt;script/g, '<script')
      .replace(/&lt;\/script&gt;/g, '</script>');
    
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
              cleanupIDs: false,
              removeXMLProcInst: false
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