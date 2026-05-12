import { describe, it, expect } from 'vitest';
import { BundleExtractor } from '../src/discovery/bundle';
import { ReplayGraph } from '../src/replay/graph';

describe('Bundle Extractor', () => {
  it('extracts endpoints from webpack bundles', () => {
    const extractor = new BundleExtractor();
    const webpackBundle = `
      !function(e){var t={};function n(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return e[r].call(o.exports,o,o.exports,n),o.l=!0,o.exports}n.m=e,n.c=t,n.d=function(e,t,r){n.o(e,t)||Object.defineProperty(e,t,{enumerable:!0,get:r})}}([
        function(e,t,n){
          const api = () => fetch("/api/v1/users");
          const gql = () => axios.post("/graphql", { query: "{ me { id } }" });
        }
      ]);
    `;
    
    const eps = extractor.extractFromSource(webpackBundle, 'main.js');
    expect(eps.length).toBe(2);
    expect(eps.some(e => e.url === '/api/v1/users' && e.method === 'GET' && e.type === 'rest')).toBe(true);
    expect(eps.some(e => e.url === '/graphql' && e.method === 'POST' && e.type === 'graphql')).toBe(true);
  });

  it('extracts from minified bundles with regex fallback', () => {
    const extractor = new BundleExtractor();
    const minified = `function a(){return fetch("/api/minified")};var b=new XMLHttpRequest;b.open("DELETE","/api/old");var pad="`.padEnd(160, 'x') + `";`;
    const eps = extractor.extractFromSource(minified, 'minified.js');
    expect(eps.length).toBe(2);
    expect(eps[0].isMinified).toBe(true);
    expect(eps.some(e => e.url === '/api/old' && e.method === 'DELETE')).toBe(true);
  });

  it('extracts from Vite bundles', () => {
    const extractor = new BundleExtractor();
    const viteBundle = `
      import { x as axios } from "./vendor.js";
      axios.put("/api/vite/update");
      const ws = new WebSocket("wss://api.example.com/stream");
    `;
    const eps = extractor.extractFromSource(viteBundle, 'index-v1.js');
    expect(eps.length).toBe(2);
    expect(eps.some(e => e.type === 'websocket' && e.url === 'wss://api.example.com/stream')).toBe(true);
  });

  it('extracts frontend route paths', () => {
    const extractor = new BundleExtractor();
    const reactRouter = `
      const routes = [
        { path: "/home", component: Home },
        { path: "/users/:id", component: UserProfile }
      ];
    `;
    const eps = extractor.extractFromSource(reactRouter, 'routes.js');
    expect(eps.length).toBe(2);
    expect(eps[0].type).toBe('route');
    expect(eps[0].provenance).toBe('inferred_route');
  });

  it('handles source maps', () => {
    const extractor = new BundleExtractor();
    const sourceMap = `{"version":3,"sources":["src/api.js"],"sourcesContent":["fetch('/api/sourcemap')"]}`;
    const eps = extractor.extractFromSource(sourceMap, 'bundle.js.map', true);
    
    expect(eps.length).toBe(1);
    expect(eps[0].provenance).toBe('source_map');
    expect(eps[0].extractionMethod).toBe('source_map');
  });

  it('integrates with ReplayGraph without coupling to capture', () => {
    const graph = new ReplayGraph();
    const extractor = new BundleExtractor(graph);
    
    extractor.extractFromSource(`fetch('/api/graph')`, 'main.js');
    
    const metrics = graph.getMetrics();
    expect(metrics.nodeCount).toBeGreaterThan(0);
  });
  
  it('detects conflicting endpoint candidates', () => {
    const extractor = new BundleExtractor();
    const conflict = `
      fetch('/api/conflict');
      axios.post('/api/conflict', { query: 'mutation' });
    `;
    const eps = extractor.extractFromSource(conflict, 'conflict.js');
    expect(eps.length).toBe(2); // One GET and one POST, so they don't exactly conflict by key, but let's test same key:
    
    const exactConflict = `
      fetch('/api/conflict');
      axios.get('/api/conflict', { query: 'mutation' });
    `;
    const eps2 = extractor.extractFromSource(exactConflict, 'conflict2.js');
    expect(eps2.length).toBe(1); // Deduplicated
  });
});
