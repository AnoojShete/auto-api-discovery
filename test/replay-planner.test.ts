import { describe, it, expect } from 'vitest';
import { ReplayPlanner } from '../src/replay/planner';
import { ReplayDependencyRecord } from '../src/replay/models';

describe('Replay Planner Abstraction', () => {
  it('determines topological execution order correctly', () => {
    const dependencies: ReplayDependencyRecord[] = [
      {
        id: '1',
        source_request_id: 'req_login',
        target_request_id: 'req_dashboard',
        dependency_type: 'token'
      },
      {
        id: '2',
        source_request_id: 'req_dashboard',
        target_request_id: 'req_settings',
        dependency_type: 'path_param'
      }
    ];

    const planner = new ReplayPlanner(dependencies);
    const order = planner.determineExecutionOrder(['req_settings', 'req_login', 'req_dashboard']);

    expect(order).toEqual(['req_login', 'req_dashboard', 'req_settings']);
  });

  it('handles cyclic dependencies gracefully', () => {
    const dependencies: ReplayDependencyRecord[] = [
      {
        id: '1',
        source_request_id: 'req_A',
        target_request_id: 'req_B',
        dependency_type: 'token'
      },
      {
        id: '2',
        source_request_id: 'req_B',
        target_request_id: 'req_A',
        dependency_type: 'token'
      }
    ];

    const planner = new ReplayPlanner(dependencies);
    const order = planner.determineExecutionOrder(['req_A', 'req_B']);
    
    // Cycle means they get appended after sorted elements (none in this case)
    expect(order).toContain('req_A');
    expect(order).toContain('req_B');
    expect(order.length).toBe(2);
  });

  it('plans auth propagation correctly', () => {
    const dependencies: ReplayDependencyRecord[] = [
      {
        id: '1',
        source_request_id: 'req_login',
        target_request_id: 'req_dashboard',
        dependency_type: 'token'
      },
      {
        id: '2',
        source_request_id: 'req_login',
        target_request_id: 'req_settings',
        dependency_type: 'cookie'
      }
    ];

    const planner = new ReplayPlanner(dependencies);
    const plans = planner.planAuthPropagation(['req_login', 'req_dashboard', 'req_settings']);

    expect(plans).toHaveLength(1);
    expect(plans[0].sourceRequestId).toBe('req_login');
    expect(plans[0].targetRequestIds).toContain('req_dashboard');
    expect(plans[0].targetRequestIds).toContain('req_settings');
    expect(plans[0].extractionRule.sourceField).toBe('response.body.token');
    expect(plans[0].extractionRule.targetHeader).toBe('Authorization');
  });

  it('groups requests accurately', () => {
    const planner = new ReplayPlanner([]);
    const groups = planner.groupRequests(['req_login', 'req_dashboard']);

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Default Execution Group');
    expect(groups[0].requests).toEqual(['req_login', 'req_dashboard']);
  });

  it('generates a full replay plan', () => {
    const dependencies: ReplayDependencyRecord[] = [
      {
        id: '1',
        source_request_id: 'req_login',
        target_request_id: 'req_dashboard',
        dependency_type: 'token'
      }
    ];

    const planner = new ReplayPlanner(dependencies);
    const requestIds = ['req_dashboard', 'req_login'];
    const plan = planner.generatePlan('job_123', requestIds);

    expect(plan.jobId).toBe('job_123');
    expect(plan.executionOrder).toEqual(['req_login', 'req_dashboard']);
    expect(plan.authPropagation).toHaveLength(1);
    expect(plan.groups).toHaveLength(1);
  });
});
