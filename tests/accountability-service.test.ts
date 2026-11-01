// @vitest-environment node
/**
 * Unit tests for the server-side accountability service (src/lib/accountability/service.ts).
 *
 * The service talks to Supabase through `createClient()` from `@/lib/supabase/server`, which needs
 * Next.js request cookies and a live database. It is replaced by test doubles:
 *
 *  - FAKE  — `FakeSupabaseClient` (tests/doubles): a working in-memory database with filtering,
 *            ordering, inserts/updates/upserts/deletes and PostgREST `single()` semantics.
 *  - STUBS — canned answers: the signed-in user returned by `auth.getUser()`, RPC responses,
 *            proof-of-work provider fetchers (`fetcherOverrides`) and a frozen system clock.
 *  - MOCKS — `vi.mock()` replaces the `createClient` and `deliverInApp` modules; the tests verify
 *            how they (and `rpc`, via `vi.spyOn`) were called.
 *
 * Tests marked `it.fails` document defects found while writing this suite: they pass only for as
 * long as the defect exists, and should be switched to `it` once the service is fixed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabaseClient } from './doubles/fake-supabase-client';
import { createClient } from '../src/lib/supabase/server';
import { deliverInApp } from '../src/lib/notifications/delivery';
import * as service from '../src/lib/accountability/service';
import type { GitHubCommitItem } from '../src/lib/integrations/proof-of-work/github';
import type { WakaTimeSummaryDay } from '../src/lib/integrations/proof-of-work/wakatime';
import type { ConsequenceDefinition, ConsequenceSnapshot } from '../src/types/domain';

vi.mock('../src/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('../src/lib/notifications/delivery', () => ({ deliverInApp: vi.fn() }));

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@pact.test' };
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const COMMITMENT_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const TASK_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_TASK_ID = '66666666-6666-4666-8666-666666666666';
const CONSEQUENCE_ID = '77777777-7777-4777-8777-777777777777';

const WINDOW_START = '2026-10-01T08:00:00.000Z';
const DEADLINE = '2026-10-01T18:00:00.000Z';

let db: FakeSupabaseClient;
const blockedFetch = vi.fn(async () => {
  throw new Error('Unit tests must not reach the network');
});

function consequence(overrides: Partial<ConsequenceDefinition> = {}): ConsequenceDefinition {
  return {
    id: CONSEQUENCE_ID,
    user_id: USER.id,
    title: 'No social media tomorrow',
    description: null,
    consequence_type: 'personal_restriction',
    action_statement: 'I will not open social apps for a full day.',
    is_enabled: true,
    is_default: false,
    priority: 0,
    verification_type: 'declaration',
    verification_config: {},
    created_at: '2026-10-01T09:00:00.000Z',
    updated_at: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

function freezeTime(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
  db = new FakeSupabaseClient({
    user: USER,
    primaryKeys: { user_accountability_preferences: 'user_id' },
  });
  vi.mocked(createClient).mockResolvedValue(db as unknown as Awaited<ReturnType<typeof createClient>>);
  vi.mocked(deliverInApp).mockResolvedValue({ channel: 'in_app', success: true, isConfigured: true });
  vi.stubGlobal('fetch', blockedFetch);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('authentication guard (stubbed auth session)', () => {
  const guarded: Array<[string, () => Promise<unknown>]> = [
    ['getConsequenceDefinitions', () => service.getConsequenceDefinitions()],
    ['getConsequenceDefinitionById', () => service.getConsequenceDefinitionById(CONSEQUENCE_ID)],
    [
      'createConsequenceDefinition',
      () =>
        service.createConsequenceDefinition({
          title: 'Cold shower',
          consequence_type: 'self_improvement',
          action_statement: 'Take a cold shower.',
        }),
    ],
    ['updateConsequenceDefinition', () => service.updateConsequenceDefinition(CONSEQUENCE_ID, { title: 'x' })],
    ['deleteConsequenceDefinition', () => service.deleteConsequenceDefinition(CONSEQUENCE_ID)],
    ['getUserAccountabilityPreferences', () => service.getUserAccountabilityPreferences()],
    ['updateUserAccountabilityPreferences', () => service.updateUserAccountabilityPreferences({ is_enabled: false })],
    ['createTaskAccountabilityCommitment', () => service.createTaskAccountabilityCommitment(TASK_ID, consequence())],
    ['getTaskAccountabilityCommitment', () => service.getTaskAccountabilityCommitment(TASK_ID)],
    ['getAccountabilityEvents', () => service.getAccountabilityEvents(COMMITMENT_ID)],
    ['getTaskAccountabilityEventHistory', () => service.getTaskAccountabilityEventHistory(TASK_ID)],
    ['getActiveVerificationSession', () => service.getActiveVerificationSession(COMMITMENT_ID)],
    ['getVerificationSessions', () => service.getVerificationSessions(COMMITMENT_ID)],
    ['getAccountabilityWaiver', () => service.getAccountabilityWaiver(COMMITMENT_ID)],
    ['verifyAndFulfillExternalProofCommitment', () => service.verifyAndFulfillExternalProofCommitment(COMMITMENT_ID)],
  ];

  it.each(guarded)('%s rejects anonymous callers before touching any table', async (_name, call) => {
    db.signInAs(null);
    const fromSpy = vi.spyOn(db, 'from');

    await expect(call()).rejects.toThrow('Authentication required.');
    expect(fromSpy).not.toHaveBeenCalled();
  });
});

describe('database errors are surfaced with context', () => {
  const failing: Array<[string, string, () => Promise<unknown>, string]> = [
    ['getConsequenceDefinitions', 'consequence_definitions', () => service.getConsequenceDefinitions(), 'Failed to fetch consequence definitions'],
    ['getConsequenceDefinitionById', 'consequence_definitions', () => service.getConsequenceDefinitionById(CONSEQUENCE_ID), 'Failed to fetch consequence definition'],
    [
      'createConsequenceDefinition',
      'consequence_definitions',
      () =>
        service.createConsequenceDefinition({
          title: 'Cold shower',
          consequence_type: 'self_improvement',
          action_statement: 'Take a cold shower.',
        }),
      'Failed to create consequence definition',
    ],
    ['updateConsequenceDefinition', 'consequence_definitions', () => service.updateConsequenceDefinition(CONSEQUENCE_ID, { title: 'x' }), 'Failed to update consequence definition'],
    ['deleteConsequenceDefinition', 'consequence_definitions', () => service.deleteConsequenceDefinition(CONSEQUENCE_ID), 'Failed to delete consequence definition'],
    ['getUserAccountabilityPreferences', 'user_accountability_preferences', () => service.getUserAccountabilityPreferences(), 'Failed to fetch user accountability preferences'],
    ['updateUserAccountabilityPreferences', 'user_accountability_preferences', () => service.updateUserAccountabilityPreferences({ is_enabled: false }), 'Failed to update user accountability preferences'],
    ['createTaskAccountabilityCommitment', 'task_accountability_commitments', () => service.createTaskAccountabilityCommitment(TASK_ID, consequence()), 'Failed to create task accountability commitment'],
    ['getTaskAccountabilityCommitment', 'task_accountability_commitments', () => service.getTaskAccountabilityCommitment(TASK_ID), 'Failed to fetch task accountability commitment'],
    ['getAccountabilityEvents', 'accountability_events', () => service.getAccountabilityEvents(COMMITMENT_ID), 'Failed to fetch accountability events'],
    ['getTaskAccountabilityEventHistory', 'accountability_events', () => service.getTaskAccountabilityEventHistory(TASK_ID), 'Failed to fetch task accountability event history'],
    ['getActiveVerificationSession', 'accountability_verification_sessions', () => service.getActiveVerificationSession(COMMITMENT_ID), 'Failed to fetch active verification session'],
    ['getVerificationSessions', 'accountability_verification_sessions', () => service.getVerificationSessions(COMMITMENT_ID), 'Failed to fetch verification sessions'],
    ['getAccountabilityWaiver', 'accountability_waivers', () => service.getAccountabilityWaiver(COMMITMENT_ID), 'Failed to fetch accountability waiver'],
  ];

  it.each(failing)('%s wraps a failing query on %s', async (_name, table, call, message) => {
    db.failNextQuery(table, { code: '08006', message: 'connection reset by peer' });

    await expect(call()).rejects.toThrow(`${message}: connection reset by peer`);
  });
});

describe('consequence definitions (in-memory fake database)', () => {
  it('lists only the signed-in user’s definitions, newest first', async () => {
    db.seed(
      'consequence_definitions',
      consequence({ id: 'older', title: 'Older', created_at: '2026-10-01T09:00:00.000Z' }),
      consequence({ id: 'newer', title: 'Newer', created_at: '2026-10-01T10:00:00.000Z' }),
      consequence({ id: 'foreign', title: 'Foreign', user_id: OTHER_USER_ID, created_at: '2026-10-01T11:00:00.000Z' })
    );

    const result = await service.getConsequenceDefinitions();

    expect(result.map((c) => c.title)).toEqual(['Newer', 'Older']);
  });

  it('finds an owned definition by id and hides other users’ definitions (PGRST116 → null)', async () => {
    db.seed(
      'consequence_definitions',
      consequence(),
      consequence({ id: 'foreign', user_id: OTHER_USER_ID })
    );

    await expect(service.getConsequenceDefinitionById(CONSEQUENCE_ID)).resolves.toMatchObject({ id: CONSEQUENCE_ID });
    await expect(service.getConsequenceDefinitionById('foreign')).resolves.toBeNull();
  });

  it('creates a trimmed, user-bound definition and fills in schema defaults', async () => {
    const created = await service.createConsequenceDefinition({
      title: '  Cold shower  ',
      consequence_type: 'self_improvement',
      action_statement: 'Take a cold shower.',
    });

    expect(created).toMatchObject({
      user_id: USER.id,
      title: 'Cold shower',
      description: null,
      is_enabled: true,
      is_default: false,
      priority: 0,
      verification_type: 'declaration',
      verification_config: {},
    });
    expect(db.rows('consequence_definitions')).toEqual([created]);
  });

  it('rejects invalid input before a database client is even created', async () => {
    await expect(
      service.createConsequenceDefinition({
        title: '   ',
        consequence_type: 'self_improvement',
        action_statement: 'Take a cold shower.',
      })
    ).rejects.toThrow('Consequence title is required.');

    expect(createClient).not.toHaveBeenCalled();
    expect(db.rows('consequence_definitions')).toHaveLength(0);
  });

  it('updates an owned definition and stamps updated_at with the current time', async () => {
    freezeTime('2026-10-02T12:00:00.000Z');
    db.seed('consequence_definitions', consequence());

    const updated = await service.updateConsequenceDefinition(CONSEQUENCE_ID, { title: 'Two days without social media' });

    expect(updated).toMatchObject({ title: 'Two days without social media', updated_at: '2026-10-02T12:00:00.000Z' });
    expect(db.rows('consequence_definitions')[0].title).toBe('Two days without social media');
  });

  it('refuses to update a definition that belongs to another user', async () => {
    db.seed('consequence_definitions', consequence({ user_id: OTHER_USER_ID, title: 'Theirs' }));

    await expect(service.updateConsequenceDefinition(CONSEQUENCE_ID, { title: 'Hijacked' })).rejects.toThrow(
      'Failed to update consequence definition'
    );
    expect(db.rows('consequence_definitions')[0].title).toBe('Theirs');
  });

  // KNOWN BUG: updateConsequenceDefinitionSchema is createConsequenceDefinitionSchema.partial(), and
  // Zod 4 still applies `.default()` values inside optional fields. A title-only update therefore
  // writes is_enabled=true, is_default=false, priority=0, verification_type='declaration' and
  // verification_config={} over the stored values (e.g. it silently drops a GitHub proof rule).
  it.fails('KNOWN BUG: a partial update keeps the settings it did not mention', async () => {
    db.seed(
      'consequence_definitions',
      consequence({
        is_enabled: false,
        is_default: true,
        priority: 50,
        verification_type: 'github_commits',
        verification_config: { min_commits: 3 },
      })
    );

    await service.updateConsequenceDefinition(CONSEQUENCE_ID, { title: 'Renamed' });

    expect(db.rows('consequence_definitions')[0]).toMatchObject({
      title: 'Renamed',
      is_enabled: false,
      is_default: true,
      priority: 50,
      verification_type: 'github_commits',
      verification_config: { min_commits: 3 },
    });
  });

  it('deletes only the signed-in user’s definition', async () => {
    db.seed(
      'consequence_definitions',
      consequence(),
      consequence({ id: 'foreign', user_id: OTHER_USER_ID })
    );

    await service.deleteConsequenceDefinition(CONSEQUENCE_ID);
    await service.deleteConsequenceDefinition('foreign');

    expect(db.rows('consequence_definitions').map((c) => c.id)).toEqual(['foreign']);
  });
});

describe('accountability preferences', () => {
  it('returns null while the user has not saved any preferences yet', async () => {
    await expect(service.getUserAccountabilityPreferences()).resolves.toBeNull();
  });

  it('upserts exactly one preferences row per user and merges partial updates', async () => {
    await service.updateUserAccountabilityPreferences({ is_enabled: false });
    const saved = await service.updateUserAccountabilityPreferences({ auto_apply_default: true });

    expect(db.rows('user_accountability_preferences')).toHaveLength(1);
    expect(saved).toMatchObject({ user_id: USER.id, is_enabled: false, auto_apply_default: true });
    await expect(service.getUserAccountabilityPreferences()).resolves.toMatchObject(saved);
  });

  it('rejects a malformed default consequence id without touching the database', async () => {
    await expect(
      service.updateUserAccountabilityPreferences({ default_consequence_id: 'not-a-uuid' })
    ).rejects.toThrow('Invalid Consequence UUID format.');
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('resolveDefaultConsequence (deterministic default selection)', () => {
  it('returns null for anonymous callers instead of throwing', async () => {
    db.signInAs(null);
    await expect(service.resolveDefaultConsequence()).resolves.toBeNull();
  });

  it('returns null when the user switched the accountability engine off', async () => {
    db.seed('user_accountability_preferences', { user_id: USER.id, is_enabled: false, default_consequence_id: CONSEQUENCE_ID });
    db.seed('consequence_definitions', consequence({ is_default: true }));

    await expect(service.resolveDefaultConsequence()).resolves.toBeNull();
  });

  it('prefers the consequence explicitly chosen in preferences', async () => {
    db.seed('user_accountability_preferences', { user_id: USER.id, is_enabled: true, default_consequence_id: CONSEQUENCE_ID });
    db.seed(
      'consequence_definitions',
      consequence({ title: 'Chosen' }),
      consequence({ id: 'flagged', title: 'Flagged default', is_default: true, priority: 999 })
    );

    await expect(service.resolveDefaultConsequence()).resolves.toMatchObject({ title: 'Chosen' });
  });

  it('falls back to priority DESC, created_at ASC, id ASC when the chosen one is disabled', async () => {
    db.seed('user_accountability_preferences', { user_id: USER.id, is_enabled: true, default_consequence_id: CONSEQUENCE_ID });
    db.seed(
      'consequence_definitions',
      consequence({ title: 'Chosen but disabled', is_enabled: false }),
      consequence({ id: 'a', title: 'Low priority', is_default: true, priority: 5 }),
      consequence({ id: 'd', title: 'Same priority, later', is_default: true, priority: 9, created_at: '2026-10-01T12:00:00.000Z' }),
      consequence({ id: 'c', title: 'Tie, higher id', is_default: true, priority: 9, created_at: '2026-10-01T11:00:00.000Z' }),
      consequence({ id: 'b', title: 'Tie, lowest id', is_default: true, priority: 9, created_at: '2026-10-01T11:00:00.000Z' }),
      consequence({ id: 'e', title: 'Not a default', priority: 99 }),
      consequence({ id: 'f', title: 'Disabled default', is_default: true, is_enabled: false, priority: 99 }),
      consequence({ id: 'g', title: 'Someone else’s', user_id: OTHER_USER_ID, is_default: true, priority: 100 })
    );

    await expect(service.resolveDefaultConsequence()).resolves.toMatchObject({ id: 'b', title: 'Tie, lowest id' });
  });

  it('resolves from flagged defaults when no preferences row exists', async () => {
    db.seed('consequence_definitions', consequence({ is_default: true }));

    await expect(service.resolveDefaultConsequence()).resolves.toMatchObject({ id: CONSEQUENCE_ID });
  });

  it('returns null when there is no usable default or the lookup fails', async () => {
    db.seed('consequence_definitions', consequence({ is_default: false }));
    await expect(service.resolveDefaultConsequence()).resolves.toBeNull();

    db.seed('consequence_definitions', consequence({ id: 'flagged', is_default: true }));
    db.failNextQuery('consequence_definitions', { message: 'statement timeout' });
    await expect(service.resolveDefaultConsequence()).resolves.toBeNull();
  });
});

describe('task accountability commitments', () => {
  it('freezes a snapshot of the consequence so later edits do not leak into the commitment', async () => {
    const source = consequence({
      title: 'Ship two commits',
      verification_type: 'github_commits',
      verification_config: { min_commits: 2 },
    });

    const commitment = await service.createTaskAccountabilityCommitment(TASK_ID, source);
    source.title = 'Edited afterwards';
    source.verification_config.min_commits = 10;

    expect(commitment).toMatchObject({
      task_id: TASK_ID,
      user_id: USER.id,
      source_consequence_id: CONSEQUENCE_ID,
      commitment_status: 'committed',
    });
    expect(db.rows('task_accountability_commitments')[0].consequence_snapshot).toEqual({
      title: 'Ship two commits',
      consequence_type: 'personal_restriction',
      action_statement: 'I will not open social apps for a full day.',
      description: null,
      verification_type: 'github_commits',
      verification_config: { min_commits: 2 },
    });
  });

  it('snapshots legacy consequences without verification settings as plain declarations', async () => {
    const legacy = { ...consequence(), description: undefined, verification_type: undefined, verification_config: undefined };

    await service.createTaskAccountabilityCommitment(TASK_ID, legacy as unknown as ConsequenceDefinition);

    expect(db.rows('task_accountability_commitments')[0].consequence_snapshot).toMatchObject({
      description: null,
      verification_type: 'declaration',
      verification_config: {},
    });
  });

  it('returns the owned commitment for a task, or null when there is none', async () => {
    db.seed(
      'task_accountability_commitments',
      { id: COMMITMENT_ID, task_id: TASK_ID, user_id: USER.id },
      { id: 'foreign', task_id: OTHER_TASK_ID, user_id: OTHER_USER_ID }
    );

    await expect(service.getTaskAccountabilityCommitment(TASK_ID)).resolves.toMatchObject({ id: COMMITMENT_ID });
    await expect(service.getTaskAccountabilityCommitment(OTHER_TASK_ID)).resolves.toBeNull();
  });
});

describe('audit history queries', () => {
  beforeEach(() => {
    db.seed(
      'accountability_events',
      { id: 'e2', user_id: USER.id, task_id: TASK_ID, commitment_id: COMMITMENT_ID, event_type: 'fulfilled', created_at: '2026-10-02T10:00:00.000Z' },
      { id: 'e1', user_id: USER.id, task_id: TASK_ID, commitment_id: COMMITMENT_ID, event_type: 'activated', created_at: '2026-10-01T18:00:00.000Z' },
      { id: 'x1', user_id: OTHER_USER_ID, task_id: TASK_ID, commitment_id: COMMITMENT_ID, event_type: 'waived', created_at: '2026-10-01T19:00:00.000Z' }
    );
    db.seed(
      'accountability_verification_sessions',
      { id: 's1', user_id: USER.id, commitment_id: COMMITMENT_ID, status: 'cancelled', started_at: '2026-10-02T08:00:00.000Z' },
      { id: 's2', user_id: USER.id, commitment_id: COMMITMENT_ID, status: 'started', started_at: '2026-10-02T09:00:00.000Z' },
      { id: 'x2', user_id: OTHER_USER_ID, commitment_id: COMMITMENT_ID, status: 'started', started_at: '2026-10-02T09:30:00.000Z' }
    );
  });

  it('lists a commitment’s events oldest first, scoped to the signed-in user', async () => {
    const events = await service.getAccountabilityEvents(COMMITMENT_ID);
    expect(events.map((e) => e.event_type)).toEqual(['activated', 'fulfilled']);
  });

  it('lists a task’s event history oldest first, scoped to the signed-in user', async () => {
    const events = await service.getTaskAccountabilityEventHistory(TASK_ID);
    expect(events.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('returns only a session that is still running as the active one', async () => {
    await expect(service.getActiveVerificationSession(COMMITMENT_ID)).resolves.toMatchObject({ id: 's2' });

    db.rows('accountability_verification_sessions')[1].status = 'completed';
    await expect(service.getActiveVerificationSession(COMMITMENT_ID)).resolves.toBeNull();
  });

  it('lists verification sessions newest first', async () => {
    const sessions = await service.getVerificationSessions(COMMITMENT_ID);
    expect(sessions.map((s) => s.id)).toEqual(['s2', 's1']);
  });

  it('returns the waiver audit record when the commitment was waived', async () => {
    await expect(service.getAccountabilityWaiver(COMMITMENT_ID)).resolves.toBeNull();

    db.seed('accountability_waivers', { id: 'w1', user_id: USER.id, commitment_id: COMMITMENT_ID });
    await expect(service.getAccountabilityWaiver(COMMITMENT_ID)).resolves.toMatchObject({ id: 'w1' });
  });
});

describe('RPC-backed state transitions (mocked rpc)', () => {
  const rpcCases = [
    {
      name: 'startAccountabilitySession',
      call: () => service.startAccountabilitySession(COMMITMENT_ID),
      rpc: 'start_accountability_session',
      params: { p_commitment_id: COMMITMENT_ID },
      failure: 'Failed to start verification session',
    },
    {
      name: 'fulfillAccountabilitySession',
      call: () => service.fulfillAccountabilitySession(SESSION_ID, '  Read 30 pages of the book  '),
      rpc: 'fulfill_accountability_session',
      params: { p_session_id: SESSION_ID, p_evidence_note: 'Read 30 pages of the book' },
      failure: 'Failed to fulfill verification session',
    },
    {
      name: 'fulfillAccountabilitySession (no evidence note)',
      call: () => service.fulfillAccountabilitySession(SESSION_ID),
      rpc: 'fulfill_accountability_session',
      params: { p_session_id: SESSION_ID, p_evidence_note: null },
      failure: 'Failed to fulfill verification session',
    },
    {
      name: 'cancelAccountabilitySession',
      call: () => service.cancelAccountabilitySession(SESSION_ID),
      rpc: 'cancel_accountability_session',
      params: { p_session_id: SESSION_ID },
      failure: 'Failed to cancel verification session',
    },
    {
      name: 'waiveAccountabilityCommitment',
      call: () => service.waiveAccountabilityCommitment(COMMITMENT_ID, ' WAIVE '),
      rpc: 'waive_accountability_commitment',
      params: { p_commitment_id: COMMITMENT_ID, p_confirmation_token: 'WAIVE' },
      failure: 'Failed to waive commitment',
    },
    {
      name: 'fulfillWrittenReflection',
      call: () => service.fulfillWrittenReflection(COMMITMENT_ID, 'I missed the deadline because I over-planned.'),
      rpc: 'fulfill_written_reflection',
      params: { p_commitment_id: COMMITMENT_ID, p_reflection_text: 'I missed the deadline because I over-planned.' },
      failure: 'Failed to fulfill written reflection',
    },
    {
      name: 'declareAccountabilityFulfillment',
      call: () => service.declareAccountabilityFulfillment(COMMITMENT_ID, 'I donated 10 EUR as promised.'),
      rpc: 'declare_accountability_fulfillment',
      params: { p_commitment_id: COMMITMENT_ID, p_declaration_statement: 'I donated 10 EUR as promised.' },
      failure: 'Failed to declare fulfillment',
    },
    {
      name: 'fulfillTaskCompletion',
      call: () => service.fulfillTaskCompletion(COMMITMENT_ID, OTHER_TASK_ID),
      rpc: 'fulfill_task_completion_commitment',
      params: { p_commitment_id: COMMITMENT_ID, p_target_task_id: OTHER_TASK_ID },
      failure: 'Failed to fulfill task completion consequence',
    },
  ];

  it.each(rpcCases)('$name calls $rpc once with sanitised parameters', async ({ call, rpc, params }) => {
    const payload = { success: true, code: 'OK' };
    const rpcMock = vi.spyOn(db, 'rpc').mockResolvedValue({ data: payload, error: null });

    await expect(call()).resolves.toEqual(payload);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith(rpc, params);
  });

  it.each(rpcCases)('$name turns an RPC error into a descriptive exception', async ({ call, failure }) => {
    vi.spyOn(db, 'rpc').mockResolvedValue({ data: null, error: { message: 'permission denied' } });

    await expect(call()).rejects.toThrow(`${failure}: permission denied`);
  });

  it.each<[string, () => Promise<unknown>, string]>([
    ['startAccountabilitySession', () => service.startAccountabilitySession('not-a-uuid'), 'Invalid commitment UUID format.'],
    ['fulfillAccountabilitySession', () => service.fulfillAccountabilitySession('42'), 'Invalid session UUID format.'],
    ['cancelAccountabilitySession', () => service.cancelAccountabilitySession(''), 'Invalid session UUID format.'],
    ['waiveAccountabilityCommitment', () => service.waiveAccountabilityCommitment(COMMITMENT_ID, '   '), 'Confirmation token is required.'],
    ['fulfillWrittenReflection', () => service.fulfillWrittenReflection(COMMITMENT_ID, 'Too short.'), 'at least 20 characters'],
    ['declareAccountabilityFulfillment', () => service.declareAccountabilityFulfillment(COMMITMENT_ID, ''), 'Declaration statement is required.'],
    ['fulfillTaskCompletion', () => service.fulfillTaskCompletion(COMMITMENT_ID, 'task-1'), 'Invalid target task UUID format.'],
  ])('%s rejects invalid input without calling the database', async (_name, call, message) => {
    const rpcMock = vi.spyOn(db, 'rpc');

    await expect(call()).rejects.toThrow(message);
    expect(createClient).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe('verifyAndFulfillExternalProofCommitment (fake DB + stubbed provider + mocked notifier)', () => {
  const commit = (sha: string, authorDate: string): GitHubCommitItem => ({
    sha,
    authorLogin: 'octocat',
    authorDate,
    message: `work ${sha}`,
    repository: 'pact/core',
  });

  const githubCommitsStub = (commits: GitHubCommitItem[]) =>
    vi.fn(async (_user: string, _token?: string | null) => ({ success: true, data: commits }));

  function seedCommitment(snapshot: Partial<ConsequenceSnapshot> | null, overrides: Record<string, unknown> = {}) {
    db.seed('task_accountability_commitments', {
      id: COMMITMENT_ID,
      task_id: TASK_ID,
      user_id: USER.id,
      commitment_status: 'activated',
      created_at: WINDOW_START,
      consequence_snapshot: snapshot && {
        title: 'Ship code',
        consequence_type: 'self_improvement',
        action_statement: 'Push two commits before the deadline.',
        description: null,
        ...snapshot,
      },
      tasks: { id: TASK_ID, created_at: '2026-10-01T07:00:00.000Z', deadline_at: DEADLINE },
      ...overrides,
    });
  }

  function linkAccount(provider: string, handle = 'octocat', token = 'gho_test_token') {
    db.seed('external_provider_integrations', { user_id: USER.id, provider, account_handle: handle, access_token: token });
  }

  beforeEach(() => {
    db.onRpc('fulfill_external_proof_commitment', () => ({
      data: { success: true, code: 'FULFILLED', data: { id: SESSION_ID, status: 'completed' } },
      error: null,
    }));
  });

  it('fulfils the commitment when enough unique commits fall inside the commitment window', async () => {
    seedCommitment({ verification_type: 'github_commits', verification_config: { min_commits: 2 } });
    linkAccount('github');
    const githubCommits = githubCommitsStub([
      commit('before-window', '2026-10-01T07:59:59.000Z'),
      commit('in-window-1', '2026-10-01T09:00:00.000Z'),
      commit('in-window-2', '2026-10-01T17:59:00.000Z'),
      commit('in-window-1', '2026-10-01T09:00:00.000Z'),
      commit('after-deadline', '2026-10-01T18:01:00.000Z'),
    ]);
    const rpcSpy = vi.spyOn(db, 'rpc');

    const result = await service.verifyAndFulfillExternalProofCommitment(COMMITMENT_ID, { githubCommits });

    expect(result).toMatchObject({ success: true, code: 'FULFILLED', data: { id: SESSION_ID, status: 'completed' } });
    expect(result.ruleResult?.evidence.map((e) => e.external_event_id)).toEqual(['in-window-1', 'in-window-2']);
    expect(result.ruleResult).toMatchObject({ window_start: WINDOW_START, window_end: DEADLINE });

    expect(githubCommits).toHaveBeenCalledWith('octocat', 'gho_test_token');
    expect(rpcSpy).toHaveBeenCalledWith('fulfill_external_proof_commitment', {
      p_commitment_id: COMMITMENT_ID,
      p_provider: 'github',
      p_rule_summary: 'Verified 2 GitHub commit(s) within commitment window (required: 2).',
      p_evidence_items: result.ruleResult?.evidence,
    });
    expect(deliverInApp).toHaveBeenCalledTimes(1);
    expect(deliverInApp).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        userId: USER.id,
        type: 'verification_completed',
        title: 'Proof-of-Work Verified',
        actionUrl: '/app/accountability',
        metadata: { provider: 'github', evidence_count: 2 },
      })
    );
    expect(JSON.stringify(result)).not.toContain('gho_test_token');
    expect(blockedFetch).not.toHaveBeenCalled();
  });

  it('falls back to the task creation time and "now" when the window bounds are missing', async () => {
    freezeTime('2026-10-01T12:00:00.000Z');
    seedCommitment(
      { verification_type: 'github_commits', verification_config: { min_commits: 1 } },
      { created_at: null, tasks: { id: TASK_ID, created_at: '2026-10-01T07:00:00.000Z', deadline_at: null } }
    );
    linkAccount('github');
    const githubCommits = githubCommitsStub([
      commit('early-but-after-task-creation', '2026-10-01T07:30:00.000Z'),
      commit('in-the-future', '2026-10-01T12:30:00.000Z'),
    ]);

    const result = await service.verifyAndFulfillExternalProofCommitment(COMMITMENT_ID, { githubCommits });

    expect(result.ruleResult).toMatchObject({
      window_start: '2026-10-01T07:00:00.000Z',
      window_end: '2026-10-01T12:00:00.000Z',
    });
    expect(result.ruleResult?.evidence.map((e) => e.external_event_id)).toEqual(['early-but-after-task-creation']);
  });

  it('does not fulfil or notify when the rule is not satisfied', async () => {
    seedCommitment({ verification_type: 'github_commits', verification_config: { min_commits: 2 } });
    linkAccount('github');
    const rpcSpy = vi.spyOn(db, 'rpc');

    const result = await service.verifyAndFulfillExternalProofCommitment(COMMITMENT_ID, {
      githubCommits: githubCommitsStub([commit('only-one', '2026-10-01T09:00:00.000Z')]),
    });

    expect(result).toMatchObject({
      success: false,
      code: 'RULE_NOT_SATISFIED',
      error: 'Found 1 of 2 required GitHub commit(s) within commitment window.',
    });
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(deliverInApp).not.toHaveBeenCalled();
  });

  it('passes provider outages through without fulfilling the commitment', async () => {
    seedCommitment({ verification_type: 'github_commits' });
    linkAccount('github');
    const rpcSpy = vi.spyOn(db, 'rpc');
    const rateLimited = vi.fn(async () => ({ success: false, isRateLimited: true, error: 'API rate limit exceeded' }));

    const result = await service.verifyAndFulfillExternalProofCommitment(COMMITMENT_ID, { githubCommits: rateLimited });

    expect(result).toMatchObject({ success: false, code: 'RATE_LIMITED', error: 'API rate limit exceeded' });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND for a commitment that belongs to another user', async () => {
    seedCommitment({ verification_type: 'github_commits' }, { user_id: OTHER_USER_ID });
    linkAccount('github');
    const githubCommits = githubCommitsStub([]);

    const result = await service.verifyAndFulfillExternalProofCommitment(COMMITMENT_ID, { githubCommits });

    expect(result).toEqual({
      success: false,
      code: 'NOT_FOUND',
      error: 'Accountability commitment not found or access denied.',
    });
    expect(githubCommits).not.toHaveBeenCalled();
  });

  it.each([
    ['a self-declaration consequence', { verification_type: 'declaration' as const }, 'declaration'],
    ['a legacy commitment without a snapshot', null, 'declaration'],
    ['a timed-session consequence', { verification_type: 'timed_session' as const }, 'timed_session'],
  ])('rejects %s as not requiring external proof', async (_label, snapshot, type) => {
    seedCommitment(snapshot);

    const result = await service.verifyAndFulfillExternalProofCommitment(COMMITMENT_ID);

    expect(result).toEqual({
      success: false,
      code: 'INVALID_VERIFICATION_TYPE',
      error: `Commitment verification type "${type}" is not an external proof requirement.`,
    });
  });

  it.each([
    ['github_pr', {}, 'GITHUB'],
    ['leetcode_solve', {}, 'LEETCODE'],
    ['codeforces_solve', {}, 'CODEFORCES'],
    ['external_proof', { provider: 'leetcode' }, 'LEETCODE'],
    ['external_proof', {}, 'GITHUB'],
  ] as const)('maps %s %j to a required %s account', async (verificationType, config, provider) => {
    seedCommitment({ verification_type: verificationType, verification_config: config });
    linkAccount('wakatime');

    const result = await service.verifyAndFulfillExternalProofCommitment(COMMITMENT_ID);

    expect(result).toEqual({
      success: false,
      code: 'NO_LINKED_ACCOUNT',
      error: `No linked ${provider} account found. Please connect your account in Settings.`,
    });
  });

  it('treats a linked integration without an account handle as not linked', async () => {
    seedCommitment({ verification_type: 'github_commits' });
    linkAccount('github', '');

    const result = await service.verifyAndFulfillExternalProofCommitment(COMMITMENT_ID);

    // Exact match: the proof-of-work engine has its own empty-handle guard with a different message
    expect(result).toEqual({
      success: false,
      code: 'NO_LINKED_ACCOUNT',
      error: 'No linked GITHUB account found. Please connect your account in Settings.',
    });
  });

  it('reports a failing fulfilment RPC and does not notify the user', async () => {
    seedCommitment({ verification_type: 'github_commits' });
    linkAccount('github');
    db.onRpc('fulfill_external_proof_commitment', () => ({ data: null, error: { message: 'deadlock detected' } }));

    const result = await service.verifyAndFulfillExternalProofCommitment(COMMITMENT_ID, {
      githubCommits: githubCommitsStub([commit('in-window', '2026-10-01T09:00:00.000Z')]),
    });

    expect(result).toMatchObject({
      success: false,
      code: 'RPC_ERROR',
      error: 'Failed to record verified proof: deadlock detected',
      ruleResult: { verified: true },
    });
    expect(deliverInApp).not.toHaveBeenCalled();
  });

  it('keeps a verified result even when the notification channel is down', async () => {
    seedCommitment({ verification_type: 'github_commits' });
    linkAccount('github');
    vi.mocked(deliverInApp).mockRejectedValueOnce(new Error('notifications table offline'));

    const result = await service.verifyAndFulfillExternalProofCommitment(COMMITMENT_ID, {
      githubCommits: githubCommitsStub([commit('in-window', '2026-10-01T09:00:00.000Z')]),
    });

    expect(result).toMatchObject({ success: true, code: 'FULFILLED' });
    expect(deliverInApp).toHaveBeenCalledTimes(1);
  });

  // KNOWN BUG: fulfill_external_proof_commitment reports business failures in its JSON body
  // ({ success: false, code: 'COMMITMENT_NOT_ACTIVATED' }), not as a PostgREST error. The service
  // only checks `rpcError`, so it answers FULFILLED and sends a "Proof-of-Work Verified"
  // notification for a commitment the database refused to fulfil.
  it.fails('KNOWN BUG: a commitment the database refuses to fulfil is not reported as FULFILLED', async () => {
    seedCommitment({ verification_type: 'github_commits' }, { commitment_status: 'committed' });
    linkAccount('github');
    db.onRpc('fulfill_external_proof_commitment', () => ({
      data: {
        success: false,
        code: 'COMMITMENT_NOT_ACTIVATED',
        error: 'Only activated accountability commitments can be fulfilled.',
      },
      error: null,
    }));

    const result = await service.verifyAndFulfillExternalProofCommitment(COMMITMENT_ID, {
      githubCommits: githubCommitsStub([commit('in-window', '2026-10-01T09:00:00.000Z')]),
    });

    expect(result).toMatchObject({ success: false, code: 'COMMITMENT_NOT_ACTIVATED' });
    expect(deliverInApp).not.toHaveBeenCalled();
  });

  // KNOWN BUG: 'wakatime_time' is an accepted verification type and the proof-of-work engine
  // evaluates WakaTime rules, but the service's provider mapping only knows GitHub, LeetCode and
  // Codeforces, so such commitments are always rejected as INVALID_VERIFICATION_TYPE.
  it.fails('KNOWN BUG: a wakatime_time commitment is verified through the WakaTime provider', async () => {
    seedCommitment({ verification_type: 'wakatime_time', verification_config: { min_minutes: 30 } });
    linkAccount('wakatime', 'dev', 'waka_test_key');
    const day: WakaTimeSummaryDay = {
      date: '2026-10-01',
      totalSeconds: 3600,
      text: '1 hr',
      projects: [],
      languages: [],
      branches: [],
      editors: [],
    };
    const wakatimeSummaries = vi.fn(async () => ({ success: true, data: [day] }));

    const result = await service.verifyAndFulfillExternalProofCommitment(COMMITMENT_ID, { wakatimeSummaries });

    expect(result).toMatchObject({ success: true, code: 'FULFILLED' });
  });
});
