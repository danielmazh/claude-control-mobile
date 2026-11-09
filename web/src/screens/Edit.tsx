import { useState } from "preact/hooks";
import { BackBar, Empty, useApp } from "../components/ui";
import type { Priority, SessionPatch } from "../types";
import { T } from "../i18n";
import { cx, PRIORITIES, priorityText } from "../util";

/** The user layer of one chat: priority, labels, note, project. */
export function EditScreen({ id }: { id: string }) {
  const { idx, deck, nav, toast } = useApp();
  const s = idx.byId.get(id);
  const [priority, setPriority] = useState<Priority>(s?.priority ?? "normal");
  const [labelIds, setLabelIds] = useState<string[]>(s?.labelIds ?? []);
  const [note, setNote] = useState(s?.note ?? "");
  const [project, setProject] = useState(s?.project ?? "");
  const [busy, setBusy] = useState(false);

  if (!s) {
    return (
      <div class="screen inner">
        <BackBar title={T.edit} />
        <Empty icon="messages" title={T.chatNotFound} text={T.goBackRetry} />
      </div>
    );
  }

  const toggle = (lid: string) => setLabelIds(labelIds.includes(lid) ? labelIds.filter((x) => x !== lid) : [...labelIds, lid]);

  const save = async (e: Event) => {
    e.preventDefault();
    const patch: SessionPatch = {};
    if (priority !== s.priority) patch.priority = priority;
    if (labelIds.join() !== s.labelIds.join()) patch.labelIds = labelIds;
    if (note !== s.note) patch.note = note;
    if (project.trim() && project.trim() !== s.project) patch.project = project.trim();
    if (!Object.keys(patch).length) return nav.back();
    setBusy(true);
    const ok = await deck.patch(s.id, patch);
    setBusy(false);
    if (ok) {
      toast(T.saved);
      nav.back();
    }
  };

  return (
    <form class="screen inner" onSubmit={save}>
      <BackBar title={T.edit} />
      <p class="edit-for">
        <bdi>{s.title}</bdi>
      </p>

      <div class="section-head">
        <h2>{T.priorityTitle}</h2>
      </div>
      <div class="segmented" role="radiogroup" aria-label={T.priorityTitle}>
        {PRIORITIES.map((p) => (
          <button type="button" key={p} role="radio" aria-checked={priority === p} class={cx("seg", priority === p && "on")} onClick={() => setPriority(p)}>
            {priorityText(p)}
          </button>
        ))}
      </div>

      <div class="section-head">
        <h2>{T.labels}</h2>
      </div>
      {deck.labels.length === 0 ? (
        <p class="hint-line">{T.noLabels}</p>
      ) : (
        <div class="label-chips">
          {deck.labels.map((l) => (
            <button
              type="button"
              key={l.id}
              class={cx("filter-chip", labelIds.includes(l.id) && "on-soft")}
              aria-pressed={labelIds.includes(l.id)}
              onClick={() => toggle(l.id)}
            >
              <span class="label-dot" style={{ background: l.color }} aria-hidden="true" />
              <bdi>{l.name}</bdi>
            </button>
          ))}
        </div>
      )}

      <div class="section-head">
        <h2>{T.note}</h2>
      </div>
      <textarea
        class="field area"
        dir="auto"
        rows={4}
        maxLength={2000}
        value={note}
        placeholder={T.notePlaceholder}
        aria-label={T.note}
        onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
      />

      <div class="section-head">
        <h2>{T.project}</h2>
      </div>
      <input
        class="field"
        dir="auto"
        value={project}
        maxLength={60}
        aria-label={T.project}
        onInput={(e) => setProject((e.target as HTMLInputElement).value)}
      />

      <button type="submit" class="btn-primary save-btn" disabled={busy}>
        {busy ? T.saving : T.save}
      </button>
    </form>
  );
}
