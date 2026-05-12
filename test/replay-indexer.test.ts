import { describe, it, expect } from 'vitest';
import { DependencyIndexer } from '../src/replay/index';
import { inferFromRequests } from '../src/replay/inference';

describe('Dependency Indexer & Inference', () => {
  it('High-cardinality tokens do not break index', () => {
    const indexer = new DependencyIndexer();
    const req = { id: 'req_source', session_id: 'sess_1', captured_at: 1000 };
    
    // 10,000 unique tokens
    const tokens = [];
    for(let i=0; i<10000; i++) {
      tokens.push({ value: `token_${i}`, path: `body[${i}]`, type: 'body' as const });
    }
    
    indexer.indexSourceTokens(req, tokens);
    const metrics = indexer.getMetrics(1);
    expect(metrics.tokenCardinality).toBe(10000);
    
    const lookup = indexer.lookup('sess_1', 'token_5000');
    expect(lookup.length).toBe(1);
    expect(lookup[0].value).toBe('token_5000');
  });
  
  it('Large-session tests', () => {
    // 100 requests in a session
    const requests = [];
    for(let i=0; i<100; i++) {
      requests.push({
        id: `req_${i}`,
        session_id: 'sess_large',
        captured_at: i * 1000,
        request_headers: { 'authorization': `Bearer supersecrettoken_${i-1}` },
        response_body: { token: `supersecrettoken_${i}` },
        response_headers: {},
        path: `/api/resource/${i}`
      });
    }
    
    // First request doesn't have an auth header that matches
    requests[0].request_headers = {};
    
    const deps = inferFromRequests(requests);
    // Should infer 99 token dependencies
    const authDeps = deps.filter(d => d.type === 'token');
    expect(authDeps.length).toBe(99);
  });
  
  it('Collision tests (same token value in different sessions)', () => {
    const indexer = new DependencyIndexer();
    indexer.indexSourceTokens({ id: 'r1', session_id: 's1', captured_at: 1 }, [{ value: 'common_val', path: 'body.id', type: 'body' }]);
    indexer.indexSourceTokens({ id: 'r2', session_id: 's2', captured_at: 2 }, [{ value: 'common_val', path: 'body.id', type: 'body' }]);
    
    const lookupS1 = indexer.lookup('s1', 'common_val');
    expect(lookupS1.length).toBe(1);
    expect(lookupS1[0].sourceRequestId).toBe('r1');
    
    const lookupS2 = indexer.lookup('s2', 'common_val');
    expect(lookupS2.length).toBe(1);
    expect(lookupS2[0].sourceRequestId).toBe('r2');
  });

  it('Scalability: Metric Inference Reduction Ratio', () => {
    const requests = [];
    // 50 requests => N^2 is 50*49/2 = 1225 comparisons
    for(let i=0; i<50; i++) {
      requests.push({
        id: `req_${i}`,
        session_id: 'sess_scale',
        captured_at: i * 1000,
        request_headers: { 'authorization': `Bearer scale_token_${i-1}` },
        response_body: { token: `scale_token_${i}` },
        response_headers: {},
        path: ''
      });
    }
    requests[0].request_headers = {};
    
    const indexer = new DependencyIndexer();
    for (const req of requests) {
      indexer.indexSourceTokens(req, [{ value: req.response_body.token, path: 'body.token', type: 'body' }]);
    }
    for (const req of requests) {
      const targetToken = req.request_headers['authorization']?.replace('Bearer ', '');
      if (targetToken) indexer.lookup(req.session_id, targetToken);
    }
    
    const metrics = indexer.getMetrics(50);
    // 1225 old vs 49 lookups
    expect(metrics.inferenceReductionRatio).toBe(1225 / 49);
  });

  it('Frequency and Temporal Windowing scoring', () => {
    const indexer = new DependencyIndexer();
    // common_val appears 10 times
    for (let i=0; i<10; i++) {
      indexer.indexSourceTokens({ id: `r_${i}`, session_id: 's1', captured_at: i * 1000 }, [{ value: 'common_val', path: 'body.id', type: 'body' }]);
    }
    
    indexer.indexSourceTokens({ id: `r_uniq`, session_id: 's1', captured_at: 10000 }, [{ value: 'uniq_val', path: 'body.id', type: 'body' }]);
    
    const freqScoreCommon = indexer.calculateFrequencyScore('common_val');
    const freqScoreUniq = indexer.calculateFrequencyScore('uniq_val');
    expect(freqScoreCommon).toBeLessThan(freqScoreUniq);
    expect(freqScoreUniq).toBe(0.1);
    expect(freqScoreCommon).toBe(-0.1); // Between 5 and 20

    const tempScoreClose = indexer.calculateTemporalWindowScore(1000, 2000); // 1s
    const tempScoreFar = indexer.calculateTemporalWindowScore(1000, 200000); // 199s
    expect(tempScoreClose).toBeGreaterThan(tempScoreFar);
    expect(tempScoreClose).toBe(0.1);
    expect(tempScoreFar).toBe(-0.2);
  });
});
