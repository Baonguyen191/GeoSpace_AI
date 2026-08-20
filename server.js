import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const isProduction = process.argv.includes("--production");
const port = Number(process.env.PORT || 5173);
const apiKey = process.env.OPENAI_API_KEY;
const geometryColors = ["default", "orange", "blue", "purple", "green", "red", "yellow", "pink", "cyan"];

const geometrySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    assistant_message: { type: "string" },
    points: {
      type: "array",
      minItems: 3,
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          x: { type: "number", minimum: -5, maximum: 5 },
          y: { type: "number", minimum: -5, maximum: 5 },
          z: { type: "number", minimum: -5, maximum: 5 },
          accent: { type: "boolean" },
          color: { type: "string", enum: geometryColors },
        },
        required: ["label", "x", "y", "z", "accent", "color"],
      },
    },
    edges: {
      type: "array",
      minItems: 3,
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          accent: { type: "boolean" },
          color: { type: "string", enum: geometryColors },
        },
        required: ["from", "to", "accent", "color"],
      },
    },
    faces: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          vertices: {
            type: "array",
            minItems: 3,
            maxItems: 12,
            items: { type: "string" },
          },
          visible: { type: "boolean" },
          color: { type: "string", enum: geometryColors },
        },
        required: ["vertices", "visible", "color"],
      },
    },
  },
  required: ["title", "assistant_message", "points", "edges", "faces"],
};

const geometryPatchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    assistant_message: { type: "string" },
    upsert_points: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          x: { type: "number", minimum: -5, maximum: 5 },
          y: { type: "number", minimum: -5, maximum: 5 },
          z: { type: "number", minimum: -5, maximum: 5 },
          accent: { type: "boolean" },
          color: { type: "string", enum: geometryColors },
        },
        required: ["label", "x", "y", "z", "accent", "color"],
      },
    },
    remove_points: { type: "array", maxItems: 24, items: { type: "string" } },
    add_edges: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          accent: { type: "boolean" },
          color: { type: "string", enum: geometryColors },
        },
        required: ["from", "to", "accent", "color"],
      },
    },
    remove_edges: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
    },
    add_faces: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          vertices: { type: "array", minItems: 3, maxItems: 12, items: { type: "string" } },
          visible: { type: "boolean" },
          color: { type: "string", enum: geometryColors },
        },
        required: ["vertices", "visible", "color"],
      },
    },
    remove_faces: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          vertices: { type: "array", minItems: 3, maxItems: 12, items: { type: "string" } },
        },
        required: ["vertices"],
      },
    },
  },
  required: ["title", "assistant_message", "upsert_points", "remove_points", "add_edges", "remove_edges", "add_faces", "remove_faces"],
};

const geometryRules = `Quy ước tọa độ: y là chiều thẳng đứng; x và z tạo mặt phẳng ngang. Tọa độ nên nằm trong khoảng -3 đến 3.
- Liệt kê mọi điểm được nhắc tới. Điểm/cạnh/mặt thuộc khối ban đầu dùng color="default".
- Điểm phụ, trung điểm, giao điểm hoặc điểm được thêm sau dùng accent=true và color="orange", trừ khi người dùng yêu cầu màu khác.
- Liệt kê tất cả cạnh của khối và mọi đoạn thẳng/đường phụ được yêu cầu. Đường phụ có accent=true và color="orange", khác màu cạnh gốc.
- Liệt kê đầy đủ các mặt biên của khối để hệ thống xác định nét khuất. Mỗi mặt ghi các đỉnh theo thứ tự quanh mặt.
- Mặt của khối dùng color="default". Mặt phẳng phụ dùng color="blue" và visible=true, trừ khi người dùng yêu cầu màu khác.
- Bảng màu: cam=orange, xanh dương=blue, tím=purple, xanh lá=green, đỏ=red, vàng=yellow, hồng=pink, xanh ngọc=cyan.
- Khi người dùng yêu cầu đổi màu một mặt phẳng, trả lại đúng mặt đó với cùng danh sách đỉnh, visible=true và color mới.
- visible=true cho tối đa 2 mặt gốc giúp người học nhận ra khối; các mặt phẳng phụ được yêu cầu tô màu vẫn có thể visible=true.
- Với trung điểm, trọng tâm, giao điểm hoặc điểm thuộc cạnh/mặt, tính tọa độ nhất quán từ các điểm liên quan.
- Quy tắc ưu tiên về định dạng: dùng $...$ cho công thức trong dòng và $$...$$ cho công thức riêng dòng.
- Không giải bài toán và không khẳng định điều đề bài không cho. assistant_message chỉ tóm tắt hình đã dựng hoặc nêu một giả định bố trí hình nếu cần.
- assistant_message dùng Markdown; mọi biểu thức/ký hiệu toán phải đặt trong \( ... \) hoặc \[ ... \].
- Nhãn điểm phải ngắn, duy nhất và giữ đúng ký hiệu trong đề.`;

const initialInstructions = `Bạn là trợ lý dựng hình học không gian cho học sinh Việt Nam.
Chuyển đề bài mới thành một mô hình 3D đầy đủ, rõ ràng và đúng quan hệ hình học.
${geometryRules}`;

const patchInstructions = `Bạn là trợ lý chỉnh sửa mô hình hình học không gian đang tồn tại.
Bạn chỉ trả về một BẢN VÁ, không trả lại toàn bộ mô hình.
- upsert_points chỉ chứa điểm mới hoặc điểm cần sửa tọa độ.
- add_edges/add_faces chứa phần cần bổ sung, phần còn thiếu hoặc phần cần đổi màu so với mô hình hiện tại.
- remove_points/remove_edges/remove_faces chỉ chứa phần người dùng yêu cầu xóa rõ ràng.
- Không đưa phần đang tồn tại vào danh sách xóa. Không tự ý thay thế toàn bộ mô hình.
- title phải mô tả toàn bộ hình sau khi cập nhật, không chỉ mô tả phần vừa thêm.
- Đề bài gốc là nền bắt buộc. Nếu mô hình hiện tại vô tình thiếu điểm, cạnh hoặc mặt quan trọng của đề gốc, hãy sửa bằng upsert/add trong cùng bản vá.
- Khi hai đoạn cắt nhau tại I, thêm I với tọa độ giao điểm và biểu diễn mỗi đường bằng hai đoạn qua I để quan hệ giao nhau rõ ràng.
- Khi xóa một điểm, liệt kê điểm đó trong remove_points; máy chủ sẽ tự xóa cạnh/mặt phụ thuộc.
${geometryRules}`;

function edgeKey(edge) {
  return [edge.from, edge.to].sort().join("\u0000");
}

function faceKey(face) {
  return [...new Set(face.vertices || [])].sort().join("\u0000");
}

function applyGeometryPatch(currentGeometry, patch) {
  const removedPoints = new Set(patch.remove_points || []);
  const points = new Map(
    (currentGeometry.points || [])
      .filter((point) => !removedPoints.has(point.label))
      .map((point) => [point.label, point]),
  );
  (patch.upsert_points || []).forEach((point) => {
    if (point?.label && !removedPoints.has(point.label)) points.set(point.label, point);
  });

  const removedEdges = new Set((patch.remove_edges || []).map(edgeKey));
  const edges = new Map();
  const addEdge = (edge, isPatchAddition = false) => {
    if (!edge?.from || !edge?.to || edge.from === edge.to) return;
    if (!points.has(edge.from) || !points.has(edge.to)) return;
    if (!isPatchAddition && removedEdges.has(edgeKey(edge))) return;
    edges.set(edgeKey(edge), edge);
  };
  (currentGeometry.edges || []).forEach(addEdge);
  (patch.add_edges || []).forEach((edge) => addEdge(edge, true));

  const removedFaces = new Set((patch.remove_faces || []).map(faceKey));
  const faces = new Map();
  const addFace = (face, isPatchAddition = false) => {
    const vertices = face?.vertices?.filter((label) => points.has(label));
    if (!vertices || vertices.length < 3) return;
    const normalizedFace = {
      vertices,
      visible: Boolean(face.visible),
      color: geometryColors.includes(face.color) ? face.color : "default",
    };
    if (!isPatchAddition && removedFaces.has(faceKey(normalizedFace))) return;
    faces.set(faceKey(normalizedFace), normalizedFace);
  };
  (currentGeometry.faces || []).forEach(addFace);
  (patch.add_faces || []).forEach((face) => addFace(face, true));

  return {
    title: patch.title?.trim() || currentGeometry.title,
    assistant_message: patch.assistant_message,
    points: [...points.values()],
    edges: [...edges.values()],
    faces: [...faces.values()],
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 40_000) throw new Error("Đề bài quá dài.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleGeometryRequest(request, response) {
  if (!apiKey) {
    sendJson(response, 500, { error: "Chưa tìm thấy OPENAI_API_KEY trong tệp .env." });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const message = typeof body.message === "string"
      ? body.message.trim()
      : typeof body.problem === "string"
        ? body.problem.trim()
        : "";
    const previousResponseId = typeof body.previous_response_id === "string"
      && /^resp_[A-Za-z0-9_-]{6,180}$/.test(body.previous_response_id)
      ? body.previous_response_id
      : null;
    const currentGeometry = body.current_geometry && typeof body.current_geometry === "object"
      ? body.current_geometry
      : null;
    const originalProblem = typeof body.original_problem === "string"
      ? body.original_problem.trim().slice(0, 8_000)
      : "";

    if (!message || message.length > 8_000) {
      sendJson(response, 400, { error: "Đề bài không hợp lệ." });
      return;
    }

    const solidProblem = /hình chóp|tứ diện|hình hộp|lập phương|lăng trụ/i.test(originalProblem);
    const needsRebuild = Boolean(
      currentGeometry
      && originalProblem
      && solidProblem
      && (!Array.isArray(currentGeometry.faces) || currentGeometry.faces.length === 0),
    );
    const isPatch = Boolean(currentGeometry && !needsRebuild);

    const input = needsRebuild
      ? `Khôi phục đầy đủ mô hình từ đề bài gốc và áp dụng luôn yêu cầu bổ sung. Phải có đủ mọi mặt biên của khối.\n\nĐề bài gốc:\n${originalProblem}\n\nYêu cầu bổ sung:\n${message}`
      : currentGeometry
        ? `Đề bài gốc:\n${originalProblem || "Không có bản ghi đề gốc; bảo toàn mô hình hiện tại."}\n\nYêu cầu tiếp theo:\n${message}\n\nMô hình ứng dụng đang hiển thị trước khi chỉnh sửa:\n${JSON.stringify(currentGeometry)}`
      : `Đề bài mới:\n${message}`;

    const responseSchema = isPatch ? geometryPatchSchema : geometrySchema;

    const requestPayload = {
      model: "gpt-5.4-mini",
      store: true,
      reasoning: { effort: "low" },
      instructions: isPatch ? patchInstructions : initialInstructions,
      input,
      text: {
        format: {
          type: "json_schema",
          name: isPatch ? "geometry_patch" : "geometry_scene",
          strict: true,
          schema: responseSchema,
        },
      },
    };
    if (previousResponseId && !needsRebuild) requestPayload.previous_response_id = previousResponseId;

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload),
    });

    const data = await openaiResponse.json();
    if (!openaiResponse.ok) {
      const message = data?.error?.message || "OpenAI không thể xử lý đề bài lúc này.";
      sendJson(response, openaiResponse.status, { error: message });
      return;
    }

    const outputText = data.output
      ?.flatMap((item) => item.content || [])
      .find((content) => content.type === "output_text")?.text;
    if (!outputText) throw new Error("AI không trả về mô hình hình học.");

    const parsedOutput = JSON.parse(outputText);
    const geometry = isPatch
      ? applyGeometryPatch(currentGeometry, parsedOutput)
      : parsedOutput;

    sendJson(response, 200, {
      geometry,
      response_id: data.id,
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Không thể dựng hình." });
  }
}

async function handleExplainRequest(request, response) {
  if (!apiKey) {
    sendJson(response, 500, { error: "Chưa tìm thấy OPENAI_API_KEY trong tệp .env." });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const originalProblem = typeof body.original_problem === "string" ? body.original_problem.trim() : "";
    const currentGeometry = body.current_geometry && typeof body.current_geometry === "object"
      ? body.current_geometry
      : null;

    if (!message || message.length > 8_000) {
      sendJson(response, 400, { error: "Câu hỏi không hợp lệ." });
      return;
    }

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        reasoning: { effort: "low" },
        instructions: `Bạn là giáo viên hình học không gian, trả lời bằng tiếng Việt.
Giải thích trực tiếp, sáng rõ và theo từng bước hợp lý. Dùng đúng ký hiệu trong đề.
Phân biệt dữ kiện, nhận xét và kết luận. Không tự thêm giả thiết.
Trình bày bằng Markdown với tiêu đề và danh sách rõ ràng, mỗi ý nằm trên một dòng riêng.
Mọi biểu thức toán phải đặt trong \( ... \) hoặc \[ ... \] để giao diện hiển thị bằng KaTeX.
Dùng lệnh LaTeX chuẩn cho ký hiệu hình học, ví dụ \parallel, \perp, \in, \cap, \triangle. Không để lệnh LaTeX nằm ngoài dấu phân cách công thức.
Quy tắc ưu tiên về định dạng: dùng $...$ cho công thức trong dòng và $$...$$ cho công thức riêng dòng.
Kết thúc ngay sau kết luận; không thêm lời mời kiểu “nếu bạn muốn, tôi có thể...”.
Đây là nhánh giảng bài: chỉ trả lời câu hỏi, không tạo hay chỉnh sửa mô hình 3D.`,
        input: `Đề bài gốc:\n${originalProblem || "Chưa có đề gốc."}\n\nMô hình hiện tại:\n${currentGeometry ? JSON.stringify(currentGeometry) : "Chưa có mô hình."}\n\nCâu hỏi:\n${message}`,
        text: { format: { type: "text" } },
      }),
    });

    const data = await openaiResponse.json();
    if (!openaiResponse.ok) {
      sendJson(response, openaiResponse.status, {
        error: data?.error?.message || "OpenAI không thể giảng bài lúc này.",
      });
      return;
    }

    const answer = data.output
      ?.flatMap((item) => item.content || [])
      .find((content) => content.type === "output_text")?.text;
    if (!answer) throw new Error("AI không trả về lời giải thích.");
    sendJson(response, 200, { answer });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Không thể giảng bài." });
  }
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function serveProductionFile(request, response) {
  const requestPath = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  const distRoot = resolve(process.cwd(), "dist");
  const safePath = decodeURIComponent(requestPath).replace(/^[/\\]+/, "");
  let filePath = resolve(distRoot, safePath);

  if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) filePath = join(filePath, "index.html");
    const content = await readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    response.end(content);
  } catch {
    const content = await readFile(join(process.cwd(), "dist", "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(content);
  }
}

let vite;
if (!isProduction) {
  const { createServer: createViteServer } = await import("vite");
  vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
}

const server = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/api/geometry") {
    await handleGeometryRequest(request, response);
    return;
  }

  if (request.method === "POST" && request.url === "/api/explain") {
    await handleExplainRequest(request, response);
    return;
  }

  if (isProduction) {
    await serveProductionFile(request, response);
    return;
  }

  vite.middlewares(request, response, () => {
    response.writeHead(404);
    response.end("Not found");
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`GeoSpace đang chạy tại http://127.0.0.1:${port}`);
});
