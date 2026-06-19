import { isTaskBoardSource, isTaskBoardStatus } from "@/features/office/tasks/types";
import { archiveSharedTask, listSharedTasks, upsertSharedTask } from "@/lib/tasks/shared-store";

/**
 * rook fork: reverted to the upstream Claw3D-native task store
 * (~/.openclaw/claw3d/task-manager/tasks.json on the host) so the
 * office's agent state machine actually picks up task_created /
 * task_updated / task_archived events and animates agents toward the
 * cards they own. The earlier Hermes-kanban-plugin proxy returned the
 * right data but skipped Claw3Ds local controller's event emission,
 * so the in-office agents never reacted.
 *
 * A best-effort mirror to ~/.hermes/kanban.db (so the Hermes Kanban
 * sidebar tab in the rook dashboard sees the same titles) fires
 * after each upstream write and never blocks the response. Failures
 * are logged but ignored — the local file is canonical and the
 * office keeps working even when the Hermes API is unreachable.
 */

const HERMES_KANBAN_URL =
  process.env.HERMES_KANBAN_URL?.trim() ||
  "http://127.0.0.1:9119/api/plugins/kanban";

const CLAW_TO_HERMES_STATUS: Record<string, string> = {
  todo: "todo",
  in_progress: "running",
  blocked: "blocked",
  review: "review",
  done: "done",
};

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const errorJson = (message: string, status: number) =>
  json({ error: message }, status);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

function mirrorUpsert(task: { id: string; title: string; description?: string; status?: string; assignedAgentId?: string | null }) {
  // Fire-and-forget. Try PATCH first; create on 404.
  const payload = {
    title: task.title,
    description: task.description ?? "",
    status: task.status ? CLAW_TO_HERMES_STATUS[task.status] ?? "todo" : undefined,
    assignee: task.assignedAgentId ?? null,
  };
  const id = encodeURIComponent(task.id);
  void (async () => {
    try {
      const patch = await fetch(`${HERMES_KANBAN_URL}/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (patch.status === 404) {
        await fetch(`${HERMES_KANBAN_URL}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: task.id, ...payload }),
        });
      }
    } catch (err) {
      console.warn("[task-store] hermes kanban mirror upsert failed:", err);
    }
  })();
}

function mirrorDelete(taskId: string) {
  void (async () => {
    try {
      await fetch(`${HERMES_KANBAN_URL}/tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
      });
    } catch (err) {
      console.warn("[task-store] hermes kanban mirror delete failed:", err);
    }
  })();
}

export async function GET() {
  try {
    return json({ tasks: listSharedTasks() });
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
  try {
    const saved = upsertSharedTask({ ...task, id, title });
    mirrorUpsert({
      id: saved.id,
      title: saved.title,
      description: saved.description,
      status: saved.status,
      assignedAgentId: saved.assignedAgentId ?? null,
    });
    return json({ task: saved });
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
    const task = archiveSharedTask(taskId);
    if (!task) {
      return errorJson("Task not found.", 404);
    }
    mirrorDelete(taskId);
    return json({ task });
  } catch (error) {
    console.error("[task-store] DELETE failed:", error);
    return errorJson("Internal error archiving task.", 500);
  }
}
