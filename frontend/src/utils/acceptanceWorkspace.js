const forbidden = /^(?:__proto__|constructor|prototype|token|confirmRealApi|confirmPaidApi|confirmNoPlatformUpload)$|password|cookie|authorization|access.?token|refresh.?token|api.?key|secret/i;
export function acceptanceDocument(raw = {}) {
  const clean = (value) => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !forbidden.test(key)).map(([key, item]) => [key, clean(item)])) : value;
  return Object.fromEntries(['report', 'realApiReport', 'issueForm', 'realApiForm'].map(key => [key, clean(raw[key] ?? null)]));
}
export const acceptanceJournalKey = actorId => `workbench.acceptance.v1.${encodeURIComponent(actorId)}`;
export function acceptanceNeedsUnloadWarning(snapshot, currentDocument = snapshot?.document) {
  if (!snapshot) return false;
  if (['dirty', 'saving', 'error', 'conflict'].includes(snapshot.status)) return true;
  // Read the live controller, not the status captured by an old React effect.
  // Also protect committed UI edits whose autosave effect has not run yet.
  return snapshot.status === 'saved' && JSON.stringify(acceptanceDocument(currentDocument)) !== JSON.stringify(acceptanceDocument(snapshot.document));
}
export function createAcceptanceWorkspace(api, { actorId, emptyDocument = {}, journal, onState = () => {}, onDocument = () => {}, delay = 350, uuid = () => crypto.randomUUID() }) {
  let context, document = acceptanceDocument(emptyDocument), status = 'loading', error = '', inFlight = null;
  let active = null, timer = null, disposed = false, journalUnavailable = false, opening = 0;
  const key = acceptanceJournalKey(actorId);
  const emit = () => { if (!disposed) onState({ context, status, error, journalUnavailable }); };
  const encoded = value => JSON.stringify(acceptanceDocument(value));
  const writeJournal = () => {
    try { journal?.setItem(key, JSON.stringify({ actorId, generation: context.generation, revision: context.revision, inFlight, document })); }
    catch { journalUnavailable = true; }
  };
  const clearJournal = () => { try { journal?.removeItem(key); } catch { journalUnavailable = true; } };
  const validContext = next => {
    if (!next || next.actorId !== actorId || typeof next.generation !== 'string' || !Number.isSafeInteger(next.revision)) throw new Error('验收工作区成员或版本不匹配，请重新登录后读取');
    return next;
  };
  async function flush() {
    clearTimeout(timer);
    if (active) return active;
    if (disposed || !context?.editable || ['loading', 'blocked', 'conflict'].includes(status) || status === 'saved') return;
    active = (async () => {
      while (!disposed) {
        inFlight ||= { expectedActorId: actorId, generation: context.generation, revision: context.revision, requestId: uuid(), document: acceptanceDocument(document) };
        writeJournal(); status = 'saving'; error = ''; emit();
        const sent = inFlight;
        try {
          const next = validContext(await api.saveAcceptanceWorkspace(sent));
          if (next.generation !== context.generation || next.unavailable || next.corrupt) throw Object.assign(new Error('验收工作区上下文已改变，请重新读取'), { status: 409 });
          context = next; inFlight = null;
          if (encoded(document) === encoded(sent.document)) { clearJournal(); status = 'saved'; emit(); break; }
          writeJournal(); status = 'dirty';
        } catch (err) {
          if (err.status >= 400 && err.status < 500 && err.status !== 409) inFlight = null;
          error = err.message; status = err.status === 409 ? 'conflict' : 'error'; writeJournal(); emit(); break;
        }
      }
    })().finally(() => { active = null; });
    return active;
  }
  async function open({ discardLocal = false } = {}) {
    if (active || disposed) return;
    const generation = ++opening;
    clearTimeout(timer); status = 'loading'; error = ''; emit();
    try {
      const next = validContext(await api.getAcceptanceWorkspace(actorId));
      if (disposed || opening !== generation) return;
      context = next;
      document = acceptanceDocument(context.document || emptyDocument); inFlight = null;
      if (discardLocal) clearJournal();
      if (context.unavailable || context.corrupt) { status = 'blocked'; onDocument(document); emit(); return; }
      let cached = null, rawCached = null;
      try { rawCached = journal?.getItem(key); } catch { journalUnavailable = true; }
      try { cached = JSON.parse(rawCached || 'null'); }
      catch { status = 'conflict'; error = '本页暂存记录损坏，请先核对已保存报告，再明确重新读取；没有自动丢弃暂存'; onDocument(document); emit(); return; }
      if (cached && !discardLocal) {
        if (cached.actorId !== actorId || cached.generation !== context.generation || !context.editable ||
            (cached.revision !== context.revision && cached.inFlight?.requestId !== context.lastRequestId)) {
          status = 'conflict'; error = '本页暂存与已保存报告的版本或权限不同，请核对并重新读取；未自动覆盖'; onDocument(document); emit(); return;
        }
        // Revalidate referenced tasks before displaying cached business content.
        const validated = await api.validateAcceptanceWorkspace(cached.document, actorId);
        if (disposed || opening !== generation) return;
        document = acceptanceDocument(validated.document);
        inFlight = cached.inFlight || null;
        if (inFlight && (inFlight.expectedActorId !== actorId || inFlight.generation !== context.generation)) throw Object.assign(new Error('待确认保存请求身份不匹配'), { status: 409 });
        status = 'dirty'; onDocument(document); emit(); await flush(); return;
      }
      status = 'saved'; onDocument(document); emit();
    } catch (err) { if (!disposed && opening === generation) { error = err.message; status = err.status === 409 ? 'conflict' : 'blocked'; emit(); } }
  }
  return {
    open, flush,
    change(value) {
      if (disposed || !context?.editable || ['loading', 'blocked', 'conflict'].includes(status)) return;
      const next = acceptanceDocument(value); if (encoded(next) === encoded(document)) return;
      document = next; writeJournal();
      if (status !== 'saving' && status !== 'error') status = 'dirty';
      emit(); clearTimeout(timer);
      if (status !== 'error') timer = setTimeout(flush, delay);
    },
    async reset() {
      if (active || !context?.editable || disposed) return;
      clearTimeout(timer);
      const previousStatus = status; status = 'saving'; emit();
      active = (async () => {
        try {
          const next = validContext(await api.resetAcceptanceWorkspace({ expectedActorId: actorId, generation: context.generation, revision: context.revision, confirm: true }));
          context = next; document = acceptanceDocument(emptyDocument); inFlight = null; clearJournal(); status = 'saved'; error = ''; if (!disposed) onDocument(document); emit();
        } catch (err) { status = err.status === 409 ? 'conflict' : previousStatus; error = err.message; emit(); throw err; }
      })().finally(() => { active = null; });
      return active;
    },
    dispose() { disposed = true; opening++; clearTimeout(timer); },
    snapshot: () => ({ context, status, error, document, inFlight, journalUnavailable })
  };
}

export function downloadAcceptanceWorkspace(document) {
  const data = JSON.stringify(acceptanceDocument(document), null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json;charset=utf-8' }));
  const link = window.document.createElement('a'); link.href = url; link.download = 'acceptance-workspace.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
