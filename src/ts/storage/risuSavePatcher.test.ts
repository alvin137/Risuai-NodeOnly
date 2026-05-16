import { describe, test, expect, vi } from 'vitest'

// Mock heavy deps so importing risuSave.ts doesn't pull the Svelte runtime
// or trigger module-level side effects. The patcher and the helper it
// delegates to are pure once `compare` is injected.
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({
    // Identity stub — character path is exercised with empty `characters`
    // arrays in this suite, but the mock has to exist so import resolution
    // works.
    chatToStub: (c: any) => c,
}))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))

const { diffArrayWithIdGuard, RisuSavePatcher } = await import('./risuSave')
const { compare } = await import('fast-json-patch')

// ──────────────────────────────────────────────────────────────────────────
// diffArrayWithIdGuard — direct tests on the structural-vs-elementwise pivot.
//
// The bug this protects against: deleting an entry from the front of an
// array of deeply nested objects (e.g. local-Risu-imported modules in the
// modules[] array) makes fast-json-patch.compare emit hundreds of thousands
// of element-wise diff ops (every index shifts by one and each slot deep-
// diffs old[i] vs new[i+1]). The resulting `patch.push(...ops)` then trips
// V8's function-argument limit and throws RangeError.
// ──────────────────────────────────────────────────────────────────────────

describe('diffArrayWithIdGuard — id-based structural detection (modules)', () => {
    const A = { id: 'a', name: 'A', cjs: 'console.log("a")' }
    const B = { id: 'b', name: 'B', cjs: 'console.log("b")' }
    const C = { id: 'c', name: 'C', cjs: 'console.log("c")' }
    const D = { id: 'd', name: 'D', cjs: 'console.log("d")' }

    test('identical arrays → no ops', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C], [A, B, C], 'id')
        expect(ops).toEqual([])
    })

    test('delete from front (the cascade case) → single replace, NOT element-wise', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C, D], [B, C, D], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [B, C, D] }])
    })

    test('delete from middle → single replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C, D], [A, C, D], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, C, D] }])
    })

    test('delete from end → single replace (length change)', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C, D], [A, B, C], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, B, C] }])
    })

    test('append new item → single replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B], [A, B, C], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, B, C] }])
    })

    test('reorder (length unchanged, ids in different positions) → single replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C], [C, A, B], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [C, A, B] }])
    })

    test('same ids, one item internally changed → element-wise diff for that index only', () => {
        const Bx = { id: 'b', name: 'B-renamed', cjs: 'console.log("b")' }
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C], [A, Bx, C], 'id')
        // Only /modules/1 path should be touched. Exact op shape depends on
        // fast-json-patch's diff strategy but it must be scoped to index 1.
        expect(ops.length).toBeGreaterThan(0)
        for (const op of ops) {
            expect(op.path.startsWith('/modules/1')).toBe(true)
        }
    })

    test('empty → empty: no ops', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [], [], 'id')
        expect(ops).toEqual([])
    })

    test('empty → non-empty: structural replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [], [A], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A] }])
    })

    test('undefined lastArr (cold init) → treated as empty', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', undefined, [A, B], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, B] }])
    })
})

describe('diffArrayWithIdGuard — ID safety belt', () => {
    // The fix targets corrupted backups where modules may have missing or
    // duplicated ids. Element-wise diff in those states is unreliable, so we
    // force a structural replace instead.

    test('falsy id in current array → structural replace', () => {
        const A = { id: 'a', name: 'A' }
        const Bbad = { id: '', name: 'B' }
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, { id: 'b', name: 'B' }], [A, Bbad], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, Bbad] }])
    })

    test('missing id field entirely → structural replace', () => {
        const A = { id: 'a', name: 'A' }
        const Bbad = { name: 'B' } as any
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, { id: 'b', name: 'B' }], [A, Bbad], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, Bbad] }])
    })

    test('duplicate ids in current array → structural replace', () => {
        const A = { id: 'a', name: 'A' }
        const Adup = { id: 'a', name: 'A2' }
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, { id: 'b', name: 'B' }], [A, Adup], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, Adup] }])
    })

    test('null entry in array → structural replace (falsy id chain)', () => {
        const A = { id: 'a', name: 'A' }
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, { id: 'b' }], [A, null as any], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, null] }])
    })
})

describe('diffArrayWithIdGuard — length-only mode (botPresets)', () => {
    // botPresets has no stable id field, so we fall back to length-only
    // structural detection.

    const P1 = { name: 'GPT-4', temperature: 80, mainPrompt: 'You are...' }
    const P2 = { name: 'Claude', temperature: 70, mainPrompt: 'You are...' }
    const P3 = { name: 'Local', temperature: 60, mainPrompt: 'You are...' }

    test('identical → no ops', () => {
        expect(diffArrayWithIdGuard(compare, '/botPresets', [P1, P2], [P1, P2], null)).toEqual([])
    })

    test('length match, one preset internally changed → element-wise diff', () => {
        const P2x = { name: 'Claude', temperature: 75, mainPrompt: 'You are...' }
        const ops = diffArrayWithIdGuard(compare, '/botPresets', [P1, P2], [P1, P2x], null)
        expect(ops.length).toBeGreaterThan(0)
        for (const op of ops) expect(op.path.startsWith('/botPresets/1')).toBe(true)
    })

    test('add preset → structural replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/botPresets', [P1, P2], [P1, P2, P3], null)
        expect(ops).toEqual([{ op: 'replace', path: '/botPresets', value: [P1, P2, P3] }])
    })

    test('delete preset from middle → structural replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/botPresets', [P1, P2, P3], [P1, P3], null)
        expect(ops).toEqual([{ op: 'replace', path: '/botPresets', value: [P1, P3] }])
    })
})

// ──────────────────────────────────────────────────────────────────────────
// Scale test — verify the helper does NOT trip the spread limit and does
// NOT explode the op count on the original bug's pathological input.
// ──────────────────────────────────────────────────────────────────────────

describe('diffArrayWithIdGuard — scale (regression)', () => {
    function makeModule(i: number) {
        // Each module is moderately deep — comparable to a real module with
        // a lorebook, regex list, and trigger list. The original bug's
        // cascade explosion happened because deep-diffing N shifted items
        // emitted O(N × deepFields) ops.
        return {
            id: `mod-${i}`,
            name: `Module ${i}`,
            description: `description for module ${i}`,
            lorebook: Array.from({ length: 20 }, (_, k) => ({
                key: `key-${i}-${k}`,
                content: `content for entry ${k} of module ${i}`,
                priority: k,
            })),
            regex: Array.from({ length: 10 }, (_, k) => ({
                pattern: `pattern-${i}-${k}`,
                replace: `replace-${i}-${k}`,
            })),
            cjs: `console.log("module ${i}");`.repeat(50),
        }
    }

    test('deleting front item of a 200-module array → 1 op, no spread crash', () => {
        const last = Array.from({ length: 200 }, (_, i) => makeModule(i))
        const cur = last.slice(1) // delete index 0
        const ops = diffArrayWithIdGuard(compare, '/modules', last, cur, 'id')
        expect(ops).toHaveLength(1)
        expect(ops[0].op).toBe('replace')
        expect(ops[0].path).toBe('/modules')
    })

    test('no-op on 200-module array → 0 ops (hot path)', () => {
        const arr = Array.from({ length: 200 }, (_, i) => makeModule(i))
        // Same reference, no change.
        const ops = diffArrayWithIdGuard(compare, '/modules', arr, arr, 'id')
        expect(ops).toEqual([])
    })

    test('original element-wise compare WOULD have produced very many ops on this input', () => {
        // Sanity check that our test input is actually pathological — if
        // this number ever drops to a small value, the regression test
        // above is no longer guarding the right thing.
        const last = Array.from({ length: 200 }, (_, i) => makeModule(i))
        const cur = last.slice(1)
        const legacyOps = compare({ modules: last }, { modules: cur })
        expect(legacyOps.length).toBeGreaterThan(1000)
    })
})

// ──────────────────────────────────────────────────────────────────────────
// RisuSavePatcher integration — exercise the full set() path.
// ──────────────────────────────────────────────────────────────────────────

function makeMod(id: string, extras: any = {}) {
    return { id, name: `mod-${id}`, description: '', ...extras }
}

const emptyToSave = () => ({
    character: [],
    chat: [] as [string, string][],
    root: false,
    botPreset: false,
    modules: false,
    loadouts: false,
    plugins: false,
    pluginCustomStorage: false,
})

describe('RisuSavePatcher.set — modules path', () => {
    test('deleting a front-loaded module emits a single replace op, no RangeError', async () => {
        const patcher = new RisuSavePatcher()
        const initialModules = [makeMod('a'), makeMod('b'), makeMod('c'), makeMod('d')]
        await patcher.init({ characters: [], botPresets: [], modules: initialModules })

        const newDb = { characters: [], botPresets: [], modules: [makeMod('b'), makeMod('c'), makeMod('d')] }
        const { patch } = await patcher.set(newDb, { ...emptyToSave(), modules: true })

        const moduleOps = patch.filter((p: any) => p.path === '/modules' || p.path.startsWith('/modules/'))
        expect(moduleOps).toEqual([
            { op: 'replace', path: '/modules', value: newDb.modules },
        ])
    })

    test('internal edit only (same id order) → element-wise diff scoped to that index', async () => {
        const patcher = new RisuSavePatcher()
        await patcher.init({
            characters: [],
            botPresets: [],
            modules: [makeMod('a'), makeMod('b', { description: 'old' })],
        })

        const newDb = {
            characters: [],
            botPresets: [],
            modules: [makeMod('a'), makeMod('b', { description: 'new' })],
        }
        const { patch } = await patcher.set(newDb, { ...emptyToSave(), modules: true })

        const moduleOps = patch.filter((p: any) => p.path.startsWith('/modules/'))
        expect(moduleOps.length).toBeGreaterThan(0)
        for (const op of moduleOps) expect(op.path.startsWith('/modules/1')).toBe(true)
        // No structural replace under those circumstances.
        expect(patch.find((p: any) => p.path === '/modules')).toBeUndefined()
    })

    test('does not throw on a pathological array that would crash the original code path', async () => {
        // ~300 modules with non-trivial internals × front delete. Old behavior
        // would balloon the op count and trip `patch.push(...arr)` spread.
        const N = 300
        const big = Array.from({ length: N }, (_, i) => makeMod(`m${i}`, {
            description: 'x'.repeat(200),
            lorebook: Array.from({ length: 10 }, (_, k) => ({ key: `k${k}`, content: 'y'.repeat(100) })),
        }))

        const patcher = new RisuSavePatcher()
        await patcher.init({ characters: [], botPresets: [], modules: big })

        // Delete the very first module — worst-case index cascade.
        const next = big.slice(1)
        const newDb = { characters: [], botPresets: [], modules: next }

        await expect(patcher.set(newDb, { ...emptyToSave(), modules: true })).resolves.toBeTruthy()
    })

    test('subsequent set() picks up the new baseline after a structural change', async () => {
        // After the fix, a structural replace updates lastSyncedDb so the
        // following set() compares against the new baseline. This is what
        // keeps the patcher converged with the server.
        const patcher = new RisuSavePatcher()
        await patcher.init({
            characters: [],
            botPresets: [],
            modules: [makeMod('a'), makeMod('b'), makeMod('c')],
        })

        // First call: delete 'a'.
        await patcher.set(
            { characters: [], botPresets: [], modules: [makeMod('b'), makeMod('c')] },
            { ...emptyToSave(), modules: true },
        )

        // Second call: no further change. Should emit 0 module ops.
        const { patch } = await patcher.set(
            { characters: [], botPresets: [], modules: [makeMod('b'), makeMod('c')] },
            { ...emptyToSave(), modules: true },
        )
        const moduleOps = patch.filter((p: any) =>
            p.path === '/modules' || p.path.startsWith('/modules/'),
        )
        expect(moduleOps).toEqual([])
    })
})

describe('RisuSavePatcher.set — botPresets path', () => {
    const preset = (name: string, extras: any = {}) => ({
        name, temperature: 80, mainPrompt: 'You are...', ...extras,
    })

    test('deleting a preset from the middle emits a single replace op', async () => {
        const patcher = new RisuSavePatcher()
        await patcher.init({
            characters: [],
            botPresets: [preset('p1'), preset('p2'), preset('p3')],
            modules: [],
        })

        const newDb = {
            characters: [],
            botPresets: [preset('p1'), preset('p3')],
            modules: [],
        }
        const { patch } = await patcher.set(newDb, { ...emptyToSave(), botPreset: true })
        const presetOps = patch.filter((p: any) =>
            p.path === '/botPresets' || p.path.startsWith('/botPresets/'),
        )
        expect(presetOps).toEqual([
            { op: 'replace', path: '/botPresets', value: newDb.botPresets },
        ])
    })

    test('editing one preset (length unchanged) emits scoped element-wise diff', async () => {
        const patcher = new RisuSavePatcher()
        await patcher.init({
            characters: [],
            botPresets: [preset('p1'), preset('p2', { temperature: 70 })],
            modules: [],
        })
        const newDb = {
            characters: [],
            botPresets: [preset('p1'), preset('p2', { temperature: 75 })],
            modules: [],
        }
        const { patch } = await patcher.set(newDb, { ...emptyToSave(), botPreset: true })
        const presetOps = patch.filter((p: any) => p.path.startsWith('/botPresets/'))
        expect(presetOps.length).toBeGreaterThan(0)
        for (const op of presetOps) expect(op.path.startsWith('/botPresets/1')).toBe(true)
        expect(patch.find((p: any) => p.path === '/botPresets')).toBeUndefined()
    })
})

// ──────────────────────────────────────────────────────────────────────────
// Round-trip integrity — the strongest correctness invariant:
//
//   applyPatch(baseline, patcher.set(newState).patch) === normalize(newState)
//
// In production, the server applies these patches with fast-json-patch's
// applyPatch on its own copy of the DB. If our generated ops don't bring
// the server's baseline up to the same state the patcher computed
// internally, the next save/load round-trip will diverge and the user
// either sees stale data or silent loss. These tests exercise the
// scenarios the fix is meant to handle and verify byte-equivalent
// reconstruction.
// ──────────────────────────────────────────────────────────────────────────

const { applyPatch } = await import('fast-json-patch')
const { normalizeJSON } = await import('./risuSave')

function applyOpsTo(baseline: any, ops: any[]) {
    // fast-json-patch mutates by default; deep-clone first to keep tests
    // independent. Also matches how the server-side applyPatch wraps the
    // call in its own copy of the DB.
    const copy = JSON.parse(JSON.stringify(baseline))
    applyPatch(copy, ops)
    return copy
}

async function runRoundTrip(
    initial: any,
    next: any,
    toSave: any,
) {
    const patcher = new RisuSavePatcher()
    await patcher.init(initial)
    const { patch } = await patcher.set(next, toSave)
    // Simulate the server's pre-image: normalized initial state.
    const serverBaseline = normalizeJSON(initial)
    const afterApply = applyOpsTo(serverBaseline, patch)
    // Simulate what the server should end up with: normalized next state,
    // with chats stub-replaced on characters (mirroring patcher.set's diff
    // input). characters are out of scope for this suite (empty arrays),
    // so the transformation collapses to plain normalize.
    const expected = normalizeJSON(next)
    return { patch, afterApply, expected }
}

describe('round-trip — patcher ops reconstruct the new state on a baseline', () => {
    test('modules: delete from front', async () => {
        const modules = [
            { id: 'a', name: 'A', cjs: 'console.log("a")' },
            { id: 'b', name: 'B', cjs: 'console.log("b")' },
            { id: 'c', name: 'C', cjs: 'console.log("c")' },
        ]
        const initial = { characters: [], botPresets: [], modules }
        const next = { characters: [], botPresets: [], modules: modules.slice(1) }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: delete from middle', async () => {
        const modules = [
            { id: 'a', name: 'A' }, { id: 'b', name: 'B' },
            { id: 'c', name: 'C' }, { id: 'd', name: 'D' },
        ]
        const initial = { characters: [], botPresets: [], modules }
        const next = { characters: [], botPresets: [], modules: [modules[0], modules[2], modules[3]] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: add to end', async () => {
        const modules = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
        const initial = { characters: [], botPresets: [], modules }
        const next = { characters: [], botPresets: [], modules: [...modules, { id: 'c', name: 'C' }] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: reorder preserves all data', async () => {
        const modules = [
            { id: 'a', name: 'A', lorebook: [{ key: 'k1', content: 'v1' }] },
            { id: 'b', name: 'B', lorebook: [{ key: 'k2', content: 'v2' }] },
            { id: 'c', name: 'C', lorebook: [{ key: 'k3', content: 'v3' }] },
        ]
        const initial = { characters: [], botPresets: [], modules }
        const next = { characters: [], botPresets: [], modules: [modules[2], modules[0], modules[1]] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: edit content of one (length unchanged, same ids)', async () => {
        const initial = {
            characters: [], botPresets: [],
            modules: [
                { id: 'a', name: 'A', description: 'old' },
                { id: 'b', name: 'B', description: 'untouched' },
            ],
        }
        const next = {
            characters: [], botPresets: [],
            modules: [
                { id: 'a', name: 'A', description: 'NEW VALUE' },
                { id: 'b', name: 'B', description: 'untouched' },
            ],
        }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: multi-level changes (add + edit at once)', async () => {
        const initial = {
            characters: [], botPresets: [],
            modules: [
                { id: 'a', name: 'A', description: 'v1' },
                { id: 'b', name: 'B', description: 'v1' },
            ],
        }
        const next = {
            characters: [], botPresets: [],
            modules: [
                { id: 'a', name: 'A', description: 'v2' },         // edited
                { id: 'b', name: 'B', description: 'v1' },
                { id: 'c', name: 'C', description: 'new' },        // added
            ],
        }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: 200-module front-delete (the original bug scenario)', async () => {
        function makeMod(i: number) {
            return {
                id: `mod-${i}`,
                name: `Module ${i}`,
                description: `desc ${i}`,
                lorebook: Array.from({ length: 10 }, (_, k) => ({
                    key: `k-${i}-${k}`, content: `v-${i}-${k}`,
                })),
                cjs: `console.log("${i}")`.repeat(10),
            }
        }
        const big = Array.from({ length: 200 }, (_, i) => makeMod(i))
        const initial = { characters: [], botPresets: [], modules: big }
        const next = { characters: [], botPresets: [], modules: big.slice(1) }
        const { patch, afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        // Sanity: not exploding into hundreds of thousands of ops
        expect(patch.length).toBeLessThan(20)
        // Server side reconstructs exactly what the patcher computed
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('botPresets: delete from middle', async () => {
        const p = (name: string, temp = 80) => ({ name, temperature: temp, mainPrompt: 'You are...' })
        const initial = { characters: [], botPresets: [p('p1'), p('p2'), p('p3')], modules: [] }
        const next = { characters: [], botPresets: [p('p1'), p('p3')], modules: [] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), botPreset: true })
        expect(afterApply.botPresets).toEqual(expected.botPresets)
    })

    test('botPresets: edit one (length unchanged)', async () => {
        const p = (name: string, temp = 80) => ({ name, temperature: temp, mainPrompt: 'You are...' })
        const initial = { characters: [], botPresets: [p('p1', 70), p('p2', 80)], modules: [] }
        const next = { characters: [], botPresets: [p('p1', 70), p('p2', 90)], modules: [] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), botPreset: true })
        expect(afterApply.botPresets).toEqual(expected.botPresets)
    })

    test('combined: edit modules and botPresets in a single save', async () => {
        const p = (name: string) => ({ name, temperature: 80, mainPrompt: 'You are...' })
        const initial = {
            characters: [],
            botPresets: [p('p1'), p('p2')],
            modules: [{ id: 'a', name: 'A', description: 'old' }],
        }
        const next = {
            characters: [],
            botPresets: [p('p1'), p('p3')],
            modules: [
                { id: 'a', name: 'A', description: 'new' },
                { id: 'b', name: 'B', description: 'added' },
            ],
        }
        const { afterApply, expected } = await runRoundTrip(initial, next, {
            ...emptyToSave(), modules: true, botPreset: true,
        })
        expect(afterApply.modules).toEqual(expected.modules)
        expect(afterApply.botPresets).toEqual(expected.botPresets)
    })

    test('ID safety belt: duplicate ids still reconstruct correctly', async () => {
        // Pathological — duplicate ids in current state. The structural-replace
        // safety belt kicks in, and the server-side state should still match.
        const initial = {
            characters: [], botPresets: [],
            modules: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
        }
        const next = {
            characters: [], botPresets: [],
            modules: [{ id: 'a', name: 'A' }, { id: 'a', name: 'A-duplicate' }],
        }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('idempotency: second save with no further changes emits no module/preset ops', async () => {
        // If the patcher's lastSyncedDb gets out of sync with the server's
        // applied state, the next set() would emit extra ops. This is the
        // exact mode that produces stale data on the user's screen.
        const modules = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
        const patcher = new RisuSavePatcher()
        await patcher.init({ characters: [], botPresets: [], modules })

        // First save: delete one module.
        const after1 = { characters: [], botPresets: [], modules: [modules[1]] }
        await patcher.set(after1, { ...emptyToSave(), modules: true })

        // Second save: no change since after1.
        const { patch } = await patcher.set(after1, { ...emptyToSave(), modules: true })
        const moduleOrPresetOps = patch.filter((p: any) =>
            p.path === '/modules' || p.path.startsWith('/modules/') ||
            p.path === '/botPresets' || p.path.startsWith('/botPresets/'),
        )
        expect(moduleOrPresetOps).toEqual([])
    })
})
