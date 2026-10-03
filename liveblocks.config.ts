import type { LiveMap, LiveObject } from "@liveblocks/client"
import type { LiveblocksNode, LiveblocksEdge } from "@liveblocks/react-flow"
import type { CanvasNode, CanvasEdge } from "@/types/canvas"

declare global {
  interface Liveblocks {
    Presence: {
      cursor: { x: number; y: number } | null;
      thinking: boolean;
    };

    Storage: {
      flow: LiveObject<{
        nodes: LiveMap<string, LiveblocksNode<CanvasNode>>;
        edges: LiveMap<string, LiveblocksEdge<CanvasEdge>>;
      }>;
    };

    UserMeta: {
      id: string;
      info: {
        name: string;
        avatar: string;
        color: string;
      };
    };

    RoomEvent:
      | { type: "ai-status"; message: string; status: "start" | "thinking" | "complete" | "error" }
      | {
          type: "stroke-add"
          stroke: {
            id: string
            points: { x: number; y: number }[]
            color: string
            width: number
            path?: string
            bounds?: { minX: number; minY: number; maxX: number; maxY: number }
          }
        }
      | { type: "stroke-erase"; strokeId: string }
      | { type: "strokes-clear" };

    ThreadMetadata: {};

    FeedMessageData: {
      // ai-status-feed
      text?: string;
      status?: "start" | "thinking" | "complete" | "error";
      // ai-chat feed
      sender?: string;
      role?: "user" | "assistant";
      content?: string;
      timestamp?: string;
    };

    RoomInfo: {};
  }
}

export {};
