import { isTaskBoardSource, isTaskBoardStatus, type TaskBoardCard, type TaskBoardStatus } from "@/features/office/tasks/types";

/**
 * rook fork: this route used to read/write a Claw3D-local task store on
 * disk. It now proxies the same operations onto the Hermes kanban plugin
 * (mounted under /api/plugins/kanban on the dashboard) so the office HQ
 * board and the Hermes "Kanban" sidebar tab share one DB at
 * ~/.hermes/kanban.db.
 *
 * The proxy hits the dashboard's loopback (127.0.0.1:9119); the dashboard
 * patch_claw3d_proxy.py allowlists /api/plugins/kanban/* in its auth
 * bypass so server-side calls don't need a session token. Browsers still
 * have to go through the regular auth-gated sidebar view of the same
 * data — this is the only path that runs without a token, and only from
 * loopback.
 */

const HERMES_KANBAN_URL =
  process.env.HERMES_KANBAN_URL?.trim() || "http://127.0.0.1:9119/api/plugins/kanban";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const errorJson = (message: string, status: number) =>
  json({ error: message }, status);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const HERMES_TO_CLAW_STATUS: Record<string, TaskBoardStatus> = {
  triage: "todo",
  todo: "todo",
  scheduled: "todo",
  ready: "todo",
  running: "in_progress",
  blocked: "blocked",
  review: "review",
  done: "done",
};

const CLAW_TO_HERMES_STATUS: Record<TaskBoardStatus, string> = {
  todo: "todo",
  in_progress: "running",
  blocked: "blocked",
  review: "review",
  done: "done",
};

function isoFrom(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date((value > 2e10 ? value : value * 1000)).toISOString();
  }
  if (typeof value === "string" && value) return value;
  return fallback;
}

function hermesToClaw(raw: Record<string, unknown>): TaskBoardCard {
  const status = HERMES_TO_CLAW_STATUS[String(raw.status ?? "")] ?? "todo";
  const now = new Date().toISOString();
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    description: String(raw.description ?? ""),
    status,
    source: "fallback_inferred",
    sourceEventId: null,
    assignedAgentId: typeof raw.assignee === "string" ? raw.assignee : null,
    createdAt: isoFrom(raw.created_at, now),
    updatedAt: isoFrom(raw.updated_at, now),
    playbookJobId: null,
    runId: typeof raw.run_id === "string" ? raw.run_id : null,
    channel: null,
    externalThreadId: null,
    lastActivityAt: isoFrom(raw.updated_at, now),
    notes: [],
    isArchived: raw.status === "archived",
    isInferred: false,
  };
}

export async function GET() {
  try {
    const res = await fetch(`${HERMES_KANBAN_URL}/board`, { cache: "no-store" });
    if (!res.ok) {
      console.error("[task-store] GET upstream", res.status);
      return errorJson(`Hermes kanban returned ${res.status}.`, 502);
    }
    const body = (await res.json()) as { columns?: { tasks?: Record<string, unknown>[] }[] };
    const tasks: TaskBoardCard[] = [];
    for (const col of body.columns ?? []) {
      for (const t of col.tasks ?? []) {
        tasks.push(hermesToClaw(t));
      }
    }
    return json({ tasks });
  } catch (error) {
    console.error("[task-store] GET failed:", error);
    return errorJson("Internal error reading task store.", 500);
  }
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson("Invalid JSON payload.", 400);
  }
  if (!isRecord(body) || !isRecord(body.task)) {
    return errorJson("Task payload is required.", 400);
  }
  const task = body.task;
  const id = typeof task.id === "string" ? task.id.trim() : "";
  const title = typeof task.title === "string" ? task.title.trim() : "";
  if (!id || !title) {
    return errorJson("Task id and title are required.", 400);
  }
  if (task.status !== undefined && !isTaskBoardStatus(task.status)) {
    return errorJson(`Invalid status: "${String(task.status)}".`, 400);
  }
  if (task.source !== undefined && !isTaskBoardSource(task.source)) {
    return errorJson(`Invalid source: "${String(task.source)}".`, 400);
  }

  // Hermes kanban uses a separate POST /tasks endpoint for create + PATCH
  // /tasks/:id for update. Prefer PATCH; fall back to POST when the
  // upstream id isn't recognised (Claw3D's local id space).
  const hermesStatus =
    task.status && typeof task.status === "string"
      ? CLAW_TO_HERMES_STATUS[task.status as TaskBoardStatus] ?? "todo"
      : undefined;
  const payload = {
    title,
    description: typeof task.description === "string" ? task.description : "",
    status: hermesStatus,
    assignee:
      typeof task.assignedAgentId === "string" ? task.assignedAgentId : null,
  };

  try {
    const patch = await fetch(`${HERMES_KANBAN_URL}/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let upstream = patch;
    if (patch.status === 404) {
      // Create new
      upstream = await fetch(`${HERMES_KANBAN_URL}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, id }),
      });
    }
    if (!upstream.ok) {
      return errorJson(`Hermes kanban write returned ${upstream.status}.`, 502);
    }
    const raw = (await upstream.json()) as Record<string, unknown>;
    return json({ task: hermesToClaw(raw) });
  } catch (error) {
    console.error("[task-store] PUT failed:", error);
    return errorJson("Internal error writing task store.", 500);
  }
}

export async function DELETE(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson("Invalid JSON payload.", 400);
  }
  if (!isRecord(body)) {
    return errorJson("Task id is required.", 400);
  }
  const taskId = typeof body.id === "string" ? body.id.trim() : "";
  if (!taskId) {
    return errorJson("Task id is required.", 400);
  }
  try {
    // Hermes uses an archived status, surfaced by DELETE /tasks/:id.
    const res = await fetch(
      `${HERMES_KANBAN_URL}/tasks/${encodeURIComponent(taskId)}`,
      { method: "DELETE" },
    );
    if (res.status === 404) {
      return errorJson("Task not found.", 404);
    }
    if (!res.ok) {
      return errorJson(`Hermes kanban delete returned ${res.status}.`, 502);
    }
    let raw: Record<string, unknown> = {};
    try {
      raw = (await res.json()) as Record<string, unknown>;
    } catch {
      raw = { id: taskId, status: "archived" };
    }
    const card = hermesToClaw({ ...raw, id: raw.id ?? taskId, status: "archived" });
    return json({ task: card });
  } catch (error) {
    console.error("[task-store] DELETE failed:", error);
    return errorJson("Internal error archiving task.", 500);
  }
}
