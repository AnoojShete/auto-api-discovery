import { classifyToken, SemanticClassification } from './classify';

export interface TokenSource {
  sourceRequestId: string;
  sessionId: string;
  value: string;
  path: string;
  sourceType: 'body' | 'header';
  capturedAt?: number;
}

export interface InferenceMetrics {
  totalLookups: number;
  totalHits: number;
  inferenceReductionRatio: number;
  tokenCardinality: number;
  averageLookupFanout: number;
  indexHitRate: number;
}

export class DependencyIndexer {
  private sessionIndex: Map<string, Map<string, TokenSource[]>> = new Map();
  private globalFrequency: Map<string, number> = new Map();
  
  private lookups = 0;
  private hits = 0;
  private fanoutSum = 0;
  
  constructor() {}

  public getMetrics(totalRequests: number): InferenceMetrics {
    const cardinality = this.globalFrequency.size;
    const avgFanout = this.lookups > 0 ? this.fanoutSum / this.lookups : 0;
    const oldN2 = (totalRequests * (totalRequests - 1)) / 2;
    const reduction = this.lookups > 0 ? oldN2 / this.lookups : 0;
    const hitRate = this.lookups > 0 ? this.hits / this.lookups : 0;
    
    return {
      totalLookups: this.lookups,
      totalHits: this.hits,
      inferenceReductionRatio: reduction,
      tokenCardinality: cardinality,
      averageLookupFanout: avgFanout,
      indexHitRate: hitRate
    };
  }

  public indexSourceTokens(request: any, tokens: Array<{ value: string; path: string; type: 'body' | 'header' }>) {
    const sessionMap = this.sessionIndex.get(request.session_id) || new Map<string, TokenSource[]>();
    
    for (const t of tokens) {
      // Update global frequency
      this.globalFrequency.set(t.value, (this.globalFrequency.get(t.value) || 0) + 1);
      
      const sources = sessionMap.get(t.value) || [];
      sources.push({
        sourceRequestId: request.id,
        sessionId: request.session_id,
        value: t.value,
        path: t.path,
        sourceType: t.type,
        capturedAt: request.captured_at
      });
      sessionMap.set(t.value, sources);
    }
    
    this.sessionIndex.set(request.session_id, sessionMap);
  }

  public lookup(sessionId: string, value: string): TokenSource[] {
    this.lookups++;
    const sessionMap = this.sessionIndex.get(sessionId);
    if (!sessionMap) return [];
    
    const sources = sessionMap.get(value) || [];
    this.fanoutSum += sources.length;
    if (sources.length > 0) {
      this.hits++;
    }
    return sources;
  }
  
  public calculateTemporalWindowScore(sourceTime?: number, targetTime?: number): number {
    if (sourceTime === undefined || targetTime === undefined) return 0;
    const diffMs = Math.abs(targetTime - sourceTime);
    // Nearby requests strengthen confidence, distant requests weaken confidence
    if (diffMs <= 5000) return 0.1;
    if (diffMs <= 30000) return 0;
    if (diffMs <= 120000) return -0.1;
    return -0.2;
  }
  
  public calculateFrequencyScore(value: string): number {
    const freq = this.globalFrequency.get(value) || 1;
    // Globally common values reduce confidence, unique values increase confidence
    if (freq === 1) return 0.1;
    if (freq <= 5) return 0;
    if (freq <= 20) return -0.1;
    return -0.3;
  }
  
  public calculateConfidence(
    baseConfidence: number, 
    classification: SemanticClassification, 
    sourceTime: number | undefined, 
    targetTime: number | undefined, 
    value: string
  ): number {
    const temporalScore = this.calculateTemporalWindowScore(sourceTime, targetTime);
    const frequencyScore = this.calculateFrequencyScore(value);
    
    const finalScore = baseConfidence + classification.confidence_modifier + temporalScore + frequencyScore;
    return Math.max(0.0, Math.min(1.0, finalScore));
  }
}
