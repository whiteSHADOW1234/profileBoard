import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { optimize } from 'svgo';

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
    
    // Calculate dimensions based on layout items
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    
    // Process each layout item to find max dimensions
    layout.forEach(item => {
      const itemLeft = item.x;
      const itemTop = item.y;
      const itemRight = item.x + item.width;
      const itemBottom = item.y + item.height;
      
      if (itemLeft < minX) minX = itemLeft;
      if (itemTop < minY) minY = itemTop;
      if (itemRight > maxX) maxX = itemRight;
      if (itemBottom > maxY) maxY = itemBottom;
    });
    
    // Ensure we have a reasonable background area (-150 to 1050 horizontally, 0 to 600 vertically)
    minX = Math.min(minX, -150);
    maxX = Math.max(maxX, 1050);
    minY = Math.min(minY, 0);
    maxY = Math.max(maxY, 600);
    
    const width = maxX - minX;
    const height = maxY - minY;
    
    // Start building the merged SVG content
    let mergedSvgString = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg 
  xmlns="http://www.w3.org/2000/svg" 
  xmlns:xlink="http://www.w3.org/1999/xlink"
  width="${width}" 
  height="${height}" 
  viewBox="${minX} ${minY} ${width} ${height}">
  <style>
    /* Ensure all animations work */
    svg * {
      transform-box: fill-box;
      transform-origin: center;
    }
  </style>
  <rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="transparent" />
`;
    
    // Process each layout item
    for (const item of layout) {
      try {
        const id = item.id;
        const x = item.x;
        const y = item.y;
        const width = item.width;
        const height = item.height;
        
        // Start a group for this item
        mergedSvgString += `  <g id="${id}" transform="translate(${x}, ${y})">
`;
        
        let svgContent;
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          const response = await fetch(item.url);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          
          if (item.type === 'svg') {
            // For SVG type, get the raw SVG content
            svgContent = await response.text();
          } else {
            // For images, create an image element
            mergedSvgString += `    <image x="0" y="0" width="${width}" height="${height}" href="${item.url}" />
`;
            mergedSvgString += `  </g>
`;
            continue; // Skip to next item
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
            // For SVG type, get the raw content
            svgContent = fileContent.toString('utf8');
          } else {
            // For images, convert to base64
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            const dataUrl = `data:${mimeType};base64,${base64}`;
            
            mergedSvgString += `    <image x="0" y="0" width="${width}" height="${height}" href="${dataUrl}" />
`;
            mergedSvgString += `  </g>
`;
            continue; // Skip to next item
          }
        } else if (item.url.startsWith('images/')) {
          // Direct path to images directory
          const imagePath = item.url;
          
          core.info(`Reading direct file path: ${imagePath}`);
          
          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}`);
          }
          
          const fileContent = await fs.readFile(assetMap.get(imagePath));
          
          if (item.type === 'svg') {
            // For SVG type, get the raw content
            svgContent = fileContent.toString('utf8');
          } else {
            // For images, convert to base64
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            const dataUrl = `data:${mimeType};base64,${base64}`;
            
            mergedSvgString += `    <image x="0" y="0" width="${width}" height="${height}" href="${dataUrl}" />
`;
            mergedSvgString += `  </g>
`;
            continue; // Skip to next item
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
        // Process SVG content to extract the inner elements
        if (svgContent) {
          // Extract the content between opening and closing SVG tags
          const svgMatch = svgContent.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
          
          if (svgMatch && svgMatch[1]) {
            // Get the inner content
            let innerContent = svgMatch[1].trim();
            
            // Extract viewBox and original dimensions
            const viewBoxMatch = svgContent.match(/viewBox=["']([^"']*)["']/i);
            const widthMatch = svgContent.match(/width=["']([^"']*)["']/i);
            const heightMatch = svgContent.match(/height=["']([^"']*)["']/i);
            
            let originalViewBox = viewBoxMatch ? viewBoxMatch[1].split(/\s+/).map(Number) : [0, 0, width, height];
            let originalWidth = widthMatch ? parseFloat(widthMatch[1]) : originalViewBox[2];
            let originalHeight = heightMatch ? parseFloat(heightMatch[1]) : originalViewBox[3];
            
            // Calculate scaling factors if needed
            let scaleX = width / originalWidth;
            let scaleY = height / originalHeight;
            
            // If substantial scaling is needed, apply it
            if (Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01) {
              mergedSvgString += `    <g transform="scale(${scaleX}, ${scaleY})">
${innerContent}
    </g>
`;
            } else {
              // Otherwise use the content as is
              mergedSvgString += innerContent + '\n';
            }
            
            // Extract and include any style or defs sections from the original SVG
            const styleMatches = svgContent.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
            if (styleMatches) {
              for (const styleMatch of styleMatches) {
                mergedSvgString += '    ' + styleMatch + '\n';
              }
            }
            
            const defsMatches = svgContent.match(/<defs[^>]*>([\s\S]*?)<\/defs>/gi);
            if (defsMatches) {
              for (const defsMatch of defsMatches) {
                mergedSvgString += '    ' + defsMatch + '\n';
              }
            }
          } else {
            // Fallback if we can't extract inner content
            mergedSvgString += `    <foreignObject width="${width}" height="${height}">
      <div xmlns="http://www.w3.org/1999/xhtml">
        <!-- Could not extract SVG content -->
      </div>
    </foreignObject>
`;
          }
        }
        
        // Close the group for this item
        mergedSvgString += `  </g>
`;
        
      } catch (error) {
        core.warning(`Error processing item ${JSON.stringify(item)}: ${error.message}`);
      }
    }
    
    // Close the SVG
    mergedSvgString += `</svg>`;
    
    // Write merged SVG to temporary file
    await fs.writeFile('merged.svg', mergedSvgString);
    
    // Optimize SVG with SVGO (with careful options to preserve animations)
    core.info('Optimizing SVG with SVGO...');
    const optimizedSvg = optimize(mergedSvgString, {
      plugins: [
        {
          name: 'preset-default',
          params: {
            overrides: {
              // Disable plugins that might break animations
              removeViewBox: false,
              removeHiddenElems: false,
              removeUselessDefs: false,
              convertStyleToAttrs: false,
              inlineStyles: false,
              minifyStyles: false,
              removeDoctype: false,
              removeXMLProcInst: false,
              removeUnknownsAndDefaults: false,
              collapseGroups: false,
              removeNonInheritableGroupAttrs: false,
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