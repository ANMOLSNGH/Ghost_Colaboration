import { auth } from "@clerk/nextjs/server"
import { prisma } from "@/lib/prisma"
import { tasks } from "@trigger.dev/sdk/v3"
import { runDesignAgent, type designAgent } from "@/trigger/design-agent"

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 })

  const body: unknown = await request.json().catch(() => ({}))
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : ""
  const roomId = typeof b.roomId === "string" ? b.roomId.trim() : ""
  const projectId = typeof b.projectId === "string" ? b.projectId.trim() : ""

  if (!prompt || !roomId || !projectId) {
    return Response.json({ error: "Missing required fields" }, { status: 400 })
  }

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

  // Execute directly via Google Gemini 3.8 Flash and Liveblocks
  try {
    const result = await runDesignAgent({ prompt, roomId, userId })

    await prisma.taskRun.create({
      data: { runId, projectId, userId },
    }).catch(() => {})

    return Response.json({ runId, summary: result.summary, success: true }, { status: 200 })
  } catch (err: unknown) {
    console.error("Direct runDesignAgent failed:", err)
    // Fallback to tasks.trigger if direct execution fails
    try {
      const handle = await tasks.trigger<typeof designAgent>("design-agent", { prompt, roomId, userId })
      await prisma.taskRun.create({
        data: { runId: handle.id, projectId, userId },
      }).catch(() => {})
      return Response.json({ runId: handle.id }, { status: 201 })
    } catch {
      const msg = err instanceof Error ? err.message : "Design agent failed"
      return Response.json({ error: msg }, { status: 500 })
    }
  }
}

