import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import Busboy from "busboy";

const isProduction = process.argv.includes("--production");
const port = Number(process.env.PORT || 5173);
const apiKey = process.env.OPENAI_API_KEY;
const datalabApiKey = process.env.DATALAB_API_KEY;
const datalabApiBase = "https://www.datalab.to/api/v1";
const maxOcrUploadSize = 12 * 1024 * 1024;
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
          movable: { type: "boolean" },
          path_from: { type: "string" },
          path_to: { type: "string" },
          position_ratio: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["label", "x", "y", "z", "accent", "color", "movable", "path_from", "path_to", "position_ratio"],
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
          movable: { type: "boolean" },
          path_from: { type: "string" },
          path_to: { type: "string" },
          position_ratio: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["label", "x", "y", "z", "accent", "color", "movable", "path_from", "path_to", "position_ratio"],
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

const tutorStepSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
    guiding_question: { type: "string" },
    student_status: {
      type: "string",
      enum: ["no_attempt", "correct", "partially_correct", "incorrect", "completed"],
    },
    should_update_geometry: { type: "boolean" },
    geometry_patch: geometryPatchSchema,
  },
  required: ["answer", "guiding_question", "student_status", "should_update_geometry", "geometry_patch"],
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
- Mọi điểm đều phải có movable, path_from, path_to và position_ratio. Điểm cố định dùng movable=false, path_from="", path_to="", position_ratio=0.
- Nếu đề nói một điểm di động/chạy/thay đổi trên một đoạn hoặc cạnh XY, dùng movable=true, path_from="X", path_to="Y", position_ratio trong [0,1] và đặt tọa độ điểm theo đúng tỉ lệ đó trên XY. Mặc định position_ratio=0.5 nếu đề không cho vị trí ban đầu.
- Chỉ đánh dấu movable=true khi hai đầu mút quỹ đạo là các điểm có thật trong mô hình. Thanh trượt sẽ cho người dùng kéo điểm từ path_from tới path_to để khảo sát lớn nhất, nhỏ nhất.
- Không ước lượng vị trí điểm phụ bằng mắt. Phải tính bằng vectơ: trung điểm là trung bình tọa độ; giao điểm đường thẳng–mặt phẳng phải giải tham số; hình chiếu vuông góc phải dùng pháp tuyến mặt phẳng.
- Nếu mặt phẳng cắt đường thẳng ngoài đoạn giữa hai đầu mút thì đặt giao điểm trên phần kéo dài đúng toán học, không ép điểm nằm trong đoạn.
- Trước khi trả kết quả, tự kiểm tra lại mọi quan hệ thẳng hàng, trung điểm, giao điểm, song song và vuông góc bằng tọa độ.
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

function splitPointSequence(token, knownLabels, expectedCount) {
  const compact = String(token || "").replace(/[^A-Z0-9′'’]/giu, "");
  const labels = [...knownLabels]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  function search(offset, parts) {
    if (offset === compact.length) {
      return !expectedCount || parts.length === expectedCount ? parts : null;
    }
    if (expectedCount && parts.length >= expectedCount) return null;
    for (const label of labels) {
      if (!compact.startsWith(label, offset)) continue;
      const result = search(offset + label.length, [...parts, label]);
      if (result) return result;
    }
    return null;
  }

  return search(0, []);
}

function pointVector(point) {
  return [Number(point.x), Number(point.y), Number(point.z)];
}

function subtractVector(left, right) {
  return left.map((value, index) => value - right[index]);
}

function addVector(left, right) {
  return left.map((value, index) => value + right[index]);
}

function scaleVector(vector, factor) {
  return vector.map((value) => value * factor);
}

function dotVector(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function crossVector(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function setPointVector(point, vector) {
  [point.x, point.y, point.z] = vector.map((value) => Math.round(value * 1_000_000) / 1_000_000);
}

function ensureAuxiliaryPointMetadata(point) {
  point.accent = true;
  if (!geometryColors.includes(point.color) || point.color === "default") point.color = "orange";
  if (typeof point.movable !== "boolean") point.movable = false;
  if (typeof point.path_from !== "string") point.path_from = "";
  if (typeof point.path_to !== "string") point.path_to = "";
  if (!Number.isFinite(Number(point.position_ratio))) point.position_ratio = 0;
}

function ensureGeometryEdge(geometry, from, to, options = {}) {
  if (!from || !to || from === to) return;
  const key = [from, to].sort().join("\u0000");
  const existing = (geometry.edges || []).find((edge) => [edge.from, edge.to].sort().join("\u0000") === key);
  if (existing) return;
  geometry.edges.push({
    from,
    to,
    accent: options.accent ?? true,
    color: options.color || "orange",
  });
}

function enforceGeometryRelations(problemText, inputGeometry) {
  if (!inputGeometry?.points || !inputGeometry?.edges || !inputGeometry?.faces) return inputGeometry;
  const geometry = inputGeometry;
  const normalizedText = String(problemText || "")
    .replace(/[$\\{}]/g, "")
    .replace(/\s+/g, " ");
  const pointMap = new Map(geometry.points.map((point) => [String(point.label || "").trim(), point]));
  const labels = new Set(pointMap.keys());

  const midpointPattern = /([A-Z][A-Z0-9′'’]*)\s+là\s+trung\s*điểm\s+(?:của\s+)?(?:đoạn\s+)?([A-Z][A-Z0-9′'’]{1,12})/giu;
  for (const match of normalizedText.matchAll(midpointPattern)) {
    const midpoint = pointMap.get(match[1]);
    const endpoints = splitPointSequence(match[2], labels, 2);
    if (!midpoint || !endpoints) continue;
    const start = pointMap.get(endpoints[0]);
    const end = pointMap.get(endpoints[1]);
    if (!start || !end) continue;
    setPointVector(midpoint, scaleVector(addVector(pointVector(start), pointVector(end)), 0.5));
    ensureAuxiliaryPointMetadata(midpoint);
  }

  const planePattern = /mặt\s+phẳng\s*\(?([A-Z][A-Z0-9′'’]{2,12})\)?([^.;]{0,240})/giu;
  for (const planeMatch of normalizedText.matchAll(planePattern)) {
    const planeLabels = splitPointSequence(planeMatch[1], labels, 3);
    if (!planeLabels) continue;
    const planePoints = planeLabels.map((label) => pointMap.get(label));
    if (planePoints.some((point) => !point)) continue;
    const planeOrigin = pointVector(planePoints[0]);
    const planeNormal = crossVector(
      subtractVector(pointVector(planePoints[1]), planeOrigin),
      subtractVector(pointVector(planePoints[2]), planeOrigin),
    );
    if (dotVector(planeNormal, planeNormal) < 1e-10) continue;

    const intersectionPattern = /cắt\s+(?:đường\s+thẳng\s+|đoạn\s+)?([A-Z][A-Z0-9′'’]{1,12})\s+tại\s+([A-Z][A-Z0-9′'’]*)/giu;
    for (const intersectionMatch of planeMatch[2].matchAll(intersectionPattern)) {
      const lineLabels = splitPointSequence(intersectionMatch[1], labels, 2);
      const intersection = pointMap.get(intersectionMatch[2]);
      if (!lineLabels || !intersection) continue;
      const lineStartPoint = pointMap.get(lineLabels[0]);
      const lineEndPoint = pointMap.get(lineLabels[1]);
      if (!lineStartPoint || !lineEndPoint) continue;
      const lineStart = pointVector(lineStartPoint);
      const lineDirection = subtractVector(pointVector(lineEndPoint), lineStart);
      const denominator = dotVector(planeNormal, lineDirection);
      if (Math.abs(denominator) < 1e-10) continue;
      const ratio = dotVector(planeNormal, subtractVector(planeOrigin, lineStart)) / denominator;
      setPointVector(intersection, addVector(lineStart, scaleVector(lineDirection, ratio)));
      ensureAuxiliaryPointMetadata(intersection);
      const extensionEndpoint = ratio < 0 ? lineLabels[0] : ratio > 1 ? lineLabels[1] : null;
      if (extensionEndpoint) ensureGeometryEdge(geometry, extensionEndpoint, intersectionMatch[2]);
    }
  }

  const projectionPattern = /([A-Z][A-Z0-9′'’]*)\s+là\s+hình\s+chiếu\s+vuông\s+góc\s+của\s+([A-Z][A-Z0-9′'’]*)\s+(?:lên|trên)\s+mặt\s+phẳng\s*\(?([A-Z][A-Z0-9′'’]{2,12})\)?/giu;
  for (const match of normalizedText.matchAll(projectionPattern)) {
    const foot = pointMap.get(match[1]);
    const source = pointMap.get(match[2]);
    const planeLabels = splitPointSequence(match[3], labels, 3);
    if (!foot || !source || !planeLabels) continue;
    const planePoints = planeLabels.map((label) => pointMap.get(label));
    if (planePoints.some((point) => !point)) continue;
    const planeOrigin = pointVector(planePoints[0]);
    const normal = crossVector(
      subtractVector(pointVector(planePoints[1]), planeOrigin),
      subtractVector(pointVector(planePoints[2]), planeOrigin),
    );
    const normalLengthSquared = dotVector(normal, normal);
    if (normalLengthSquared < 1e-10) continue;
    const sourceVector = pointVector(source);
    const distanceFactor = dotVector(normal, subtractVector(sourceVector, planeOrigin)) / normalLengthSquared;
    setPointVector(foot, subtractVector(sourceVector, scaleVector(normal, distanceFactor)));
    ensureAuxiliaryPointMetadata(foot);
    geometry.edges = geometry.edges.filter((edge) => (
      ![edge.from, edge.to].includes(match[1])
      || [edge.from, edge.to].includes(match[2])
    ));
    ensureGeometryEdge(geometry, match[2], match[1]);
  }

  const lineProjectionPattern = /(?:điểm\s+)?([A-Z][A-Z0-9′'’]*)\s+là\s+hình\s+chiếu(?:\s+vuông\s+góc)?\s+của\s+(?:điểm\s+)?([A-Z][A-Z0-9′'’]*)\s+(?:lên|trên)\s+(?:đường\s+thẳng\s+|đoạn\s+thẳng\s+|đoạn\s+)?([A-Z][A-Z0-9′'’]{1,12})/giu;
  for (const match of normalizedText.matchAll(lineProjectionPattern)) {
    const foot = pointMap.get(match[1]);
    const source = pointMap.get(match[2]);
    const lineLabels = splitPointSequence(match[3], labels, 2);
    if (!foot || !source || !lineLabels) continue;
    const lineStartPoint = pointMap.get(lineLabels[0]);
    const lineEndPoint = pointMap.get(lineLabels[1]);
    if (!lineStartPoint || !lineEndPoint) continue;
    const lineStart = pointVector(lineStartPoint);
    const lineDirection = subtractVector(pointVector(lineEndPoint), lineStart);
    const lineLengthSquared = dotVector(lineDirection, lineDirection);
    if (lineLengthSquared < 1e-10) continue;
    const projectionRatio = dotVector(
      subtractVector(pointVector(source), lineStart),
      lineDirection,
    ) / lineLengthSquared;
    setPointVector(foot, addVector(lineStart, scaleVector(lineDirection, projectionRatio)));
    ensureAuxiliaryPointMetadata(foot);
    ensureGeometryEdge(geometry, match[2], match[1]);
  }

  const movablePattern = /(?:điểm\s+)?([A-Z][A-Z0-9′'’]*)\s+di\s*động\s+(?:trên|thuộc)\s+(?:đoạn|cạnh)?\s*([A-Z][A-Z0-9′'’]{1,12})/giu;
  for (const match of normalizedText.matchAll(movablePattern)) {
    const movablePoint = pointMap.get(match[1]);
    const endpoints = splitPointSequence(match[2], labels, 2);
    if (!movablePoint || !endpoints) continue;
    const start = pointMap.get(endpoints[0]);
    const end = pointMap.get(endpoints[1]);
    if (!start || !end) continue;
    const ratio = Math.min(1, Math.max(0, Number(movablePoint.position_ratio) || 0.5));
    movablePoint.movable = true;
    movablePoint.path_from = endpoints[0];
    movablePoint.path_to = endpoints[1];
    movablePoint.position_ratio = ratio;
    ensureAuxiliaryPointMetadata(movablePoint);
    movablePoint.movable = true;
    setPointVector(
      movablePoint,
      addVector(pointVector(start), scaleVector(subtractVector(pointVector(end), pointVector(start)), ratio)),
    );
  }

  return geometry;
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

function readUploadedImage(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    let image = null;
    let uploadError = null;
    const parser = Busboy({
      headers: request.headers,
      limits: { files: 1, fileSize: maxOcrUploadSize, fields: 2 },
    });

    parser.on("file", (fieldName, stream, fileInfo) => {
      if (fieldName !== "image" || image) {
        stream.resume();
        return;
      }

      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        chunks.push(chunk);
      });
      stream.on("limit", () => {
        uploadError = new Error("Ảnh vượt quá giới hạn 12 MB.");
      });
      stream.on("end", () => {
        if (uploadError) return;
        image = {
          buffer: Buffer.concat(chunks),
          filename: String(fileInfo.filename || "de-bai.png").slice(0, 180),
          mimeType: String(fileInfo.mimeType || "").toLowerCase(),
          size,
        };
      });
    });

    parser.on("filesLimit", () => {
      uploadError = new Error("Chỉ được tải lên một ảnh mỗi lần.");
    });
    parser.on("error", rejectPromise);
    parser.on("finish", () => {
      if (uploadError) {
        rejectPromise(uploadError);
        return;
      }
      if (!image?.buffer?.length) {
        rejectPromise(new Error("Không tìm thấy ảnh đề bài."));
        return;
      }
      resolvePromise(image);
    });
    request.pipe(parser);
  });
}

const OCR_LATEX_SYMBOLS = {
  angle: "∠",
  cap: "∩",
  cdot: "·",
  circ: "°",
  cup: "∪",
  degree: "°",
  ge: "≥",
  geq: "≥",
  in: "∈",
  le: "≤",
  leftrightarrow: "↔",
  leq: "≤",
  ne: "≠",
  neq: "≠",
  notin: "∉",
  parallel: "∥",
  perp: "⊥",
  rightarrow: "→",
  subset: "⊂",
  supset: "⊃",
  times: "×",
  triangle: "△",
};

function normalizeOcrMath(value) {
  return String(value || "")
    .replace(/\\(?:operatorname|mathrm|mathbf|text)\{([^{}]*)\}/g, "$1")
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)")
    .replace(/\\sqrt\{([^{}]+)\}/g, (_, radicand) => (
      /^[A-Za-z0-9]+$/.test(radicand) ? `√${radicand}` : `√(${radicand})`
    ))
    .replace(/\\(?:vec|overrightarrow)\{([^{}]+)\}/g, "$1⃗")
    .replace(/\\overline\{([^{}]+)\}/g, "$1")
    .replace(
      /\\(angle|cap|cdot|circ|cup|degree|geq|ge|leftrightarrow|leq|le|neq|ne|notin|parallel|perp|rightarrow|subset|supset|times|triangle|in)\b/g,
      (_, command) => OCR_LATEX_SYMBOLS[command] || command,
    )
    .replace(/\\(?:left|right)\b/g, "")
    .replace(/\^\{?2\}?/g, "²")
    .replace(/\^\{?3\}?/g, "³")
    .replace(/_\{([^{}]+)\}/g, "$1")
    .replace(/\\(?:\(|\)|\[|\])/g, "")
    .replace(/\${1,2}/g, "")
    .replace(/\\[,;!:]\s*/g, " ")
    .replace(/\\\\/g, "\n")
    .replace(/\\([A-Za-z]+)/g, "$1")
    .replace(/[{}]/g, "");
}

function cleanOcrMarkdown(value) {
  return normalizeOcrMath(value)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/^\s*(?:-{3,}|_{3,})\s*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pollDatalabResult(checkUrl) {
  const parsedUrl = new URL(checkUrl);
  if (parsedUrl.origin !== "https://www.datalab.to") {
    throw new Error("Địa chỉ kiểm tra OCR không hợp lệ.");
  }

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(parsedUrl, {
      headers: { "X-API-Key": datalabApiKey },
      signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result?.error || "Không thể kiểm tra kết quả Chandra OCR 2.");
    }
    if (result.status === "complete") {
      if (result.success === false) throw new Error(result.error || "Chandra OCR 2 không đọc được ảnh.");
      return result;
    }
    if (["failed", "error", "cancelled"].includes(result.status)) {
      throw new Error(result.error || "Chandra OCR 2 không đọc được ảnh.");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  }

  throw new Error("Chandra OCR 2 xử lý quá lâu. Hãy thử lại với ảnh rõ và nhỏ hơn.");
}

async function handleOcrRequest(request, response) {
  if (!datalabApiKey) {
    sendJson(response, 503, {
      error: "Chưa cấu hình DATALAB_API_KEY cho Chandra OCR 2 trong tệp .env.",
    });
    return;
  }

  try {
    const image = await readUploadedImage(request);
    const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!supportedTypes.has(image.mimeType)) {
      sendJson(response, 415, { error: "Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP." });
      return;
    }

    const form = new FormData();
    form.append("file", new Blob([image.buffer], { type: image.mimeType }), image.filename);
    form.append("output_format", "markdown");
    form.append("mode", "balanced");
    form.append("max_pages", "1");
    form.append("disable_image_extraction", "true");
    form.append("disable_image_captions", "true");
    form.append("extras", "new_block_types");

    const submitResponse = await fetch(datalabApiBase + "/convert", {
      method: "POST",
      headers: { "X-API-Key": datalabApiKey },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const submitted = await submitResponse.json();
    if (!submitResponse.ok || submitted.success === false) {
      throw new Error(submitted?.error || "Không thể gửi ảnh tới Chandra OCR 2.");
    }

    const result = submitted.status === "complete"
      ? submitted
      : await pollDatalabResult(
        submitted.request_check_url
          || datalabApiBase + "/convert/" + encodeURIComponent(submitted.request_id || ""),
      );
    const text = cleanOcrMarkdown(result.markdown);
    if (!text) throw new Error("Chandra OCR 2 không tìm thấy nội dung đề bài trong ảnh.");

    sendJson(response, 200, {
      text,
      provider: "Chandra OCR 2",
      page_count: result.page_count || 1,
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Không thể đọc đề bài từ ảnh." });
  }
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
      store: false,
      reasoning: { effort: "low" },
      instructions: isPatch ? patchInstructions : initialInstructions,
      input,
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: isPatch ? "geometry_patch" : "geometry_scene",
          strict: true,
          schema: responseSchema,
        },
      },
    };

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
    const generatedGeometry = isPatch
      ? applyGeometryPatch(currentGeometry, parsedOutput)
      : parsedOutput;
    const geometry = enforceGeometryRelations(
      `${originalProblem}\n${message}`,
      generatedGeometry,
    );

    sendJson(response, 200, {
      geometry,
      response_id: null,
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Không thể dựng hình." });
  }
}

async function handleGeometryRepairRequest(request, response) {
  try {
    const body = await readJsonBody(request);
    const originalProblem = typeof body.original_problem === "string"
      ? body.original_problem.trim().slice(0, 8_000)
      : "";
    const geometry = body.current_geometry && typeof body.current_geometry === "object"
      ? body.current_geometry
      : null;
    const relationContext = typeof body.relation_context === "string"
      ? body.relation_context.trim().slice(-12_000)
      : "";
    if (!originalProblem || !geometry) {
      sendJson(response, 400, { error: "Thiếu đề bài hoặc mô hình cần kiểm tra." });
      return;
    }
    sendJson(response, 200, {
      geometry: enforceGeometryRelations(
        [originalProblem, relationContext].filter(Boolean).join("\n"),
        geometry,
      ),
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Không thể kiểm tra lại hình." });
  }
}

function normalizeTutorMathControls(value) {
  const wrapMath = (_match, expression) => {
    const cleanExpression = String(expression)
      .trim()
      .replace(/^\\?\(\s*/, "")
      .replace(/\s*\\?\)$/, "")
      .trim();
    return cleanExpression ? `\\(${cleanExpression}\\)` : "";
  };

  return String(value)
    .replace(/[\u000E\u0010]([\s\S]*?)[\u000F\u0011]/g, wrapMath)
    .replace(/(?:\\u0010|\\x10)([\s\S]*?)(?:\\u0011|\\x11)/gi, wrapMath)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFC\uFFFD]/g, "")
    .replace(/\\(?:u00(?:0[0-8BCEF]|1[0-9A-F])|x(?:0[0-8BCEF]|1[0-9A-F]|7F))/gi, "");
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
    const conversation = Array.isArray(body.conversation)
      ? body.conversation
        .filter((item) => item && ["user", "assistant"].includes(item.type) && typeof item.text === "string")
        .slice(-24)
        .map((item) => ({
          role: item.type === "assistant" ? "Giáo viên" : "Học sinh",
          text: normalizeTutorMathControls(item.text).slice(0, 4_000),
        }))
      : [];

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
        store: false,
        reasoning: { effort: "medium" },
        instructions: String.raw`Bạn là gia sư hình học không gian theo phương pháp Socratic cho học sinh Việt Nam.

CHẾ ĐỘ HỎI–ĐÁP BẮT BUỘC:
- Đây không phải chế độ giảng bài. Không tự trình bày bài từ đầu đến cuối và không tự tiếp tục sang phần học sinh chưa hỏi.
- Chỉ giải thích chính xác nội dung trong tin nhắn mới nhất của học sinh. Không thêm kiến thức, bước giải, kết quả hoặc cấu dựng nằm ngoài phạm vi đó.
- Nếu học sinh hỏi một khái niệm hoặc lý do, trả lời đúng phần ấy bằng tối đa 100 từ rồi đặt một câu hỏi ngắn để kiểm tra hoặc gợi mở ngay tại chỗ.
- Nếu học sinh đang trả lời câu hỏi trước, chỉ đánh giá câu trả lời đó. Đúng thì xác nhận và hỏi một câu kế tiếp; sai hoặc thiếu thì gợi ý nhỏ hơn nhưng vẫn giữ nguyên phần đang hỏi.
- Không dùng bố cục bài giảng dài, không liệt kê toàn bộ dữ kiện và không tóm tắt toàn bộ lời giải.

MỤC TIÊU BẮT BUỘC:
- Tuyệt đối không đưa ngay đáp án, kết quả cần chứng minh, giá trị lớn nhất/nhỏ nhất hoặc toàn bộ lời giải.
- Mỗi lượt chỉ xử lý MỘT bước suy luận nhỏ. Giải thích vì sao cần bước đó, dữ kiện nào được dùng và định lý/công cụ nào phù hợp.
- answer chỉ chứa phản hồi và gợi ý của đúng một bước, không chứa câu hỏi và không có mục “Câu hỏi cho em”.
- guiding_question chứa đúng MỘT câu hỏi gợi mở cụ thể để học sinh tự trả lời; không ghép nhiều câu hỏi và phải kết thúc bằng dấu hỏi.
- Nếu học sinh xin đáp án hoặc nói “giải luôn”, vẫn không tiết lộ; hãy chia câu hỏi thành bước nhỏ hơn.

ĐÁNH GIÁ CÂU TRẢ LỜI:
- Đọc lịch sử để biết câu cuối của học sinh là yêu cầu bắt đầu, một câu hỏi hay một câu trả lời cho bước trước.
- no_attempt: học sinh đang đặt câu hỏi mới hoặc xin gợi ý; chỉ trả lời đúng phạm vi câu hỏi đó, không mở một bài giảng tuần tự.
- correct: câu trả lời đúng và đủ cho bước hiện tại. Chỉ khi đó mới xác nhận ngắn gọn, giải thích vì sao đúng rồi gợi ý bước kế tiếp.
- partially_correct: có ý đúng nhưng thiếu điều kiện/lập luận. Không chuyển bước; hỏi đúng phần còn thiếu.
- incorrect: chỉ rõ chỗ chưa phù hợp mà không chê bai, nhắc lại dữ kiện/định lý cần xem và hỏi một câu nhỏ hơn. Không chuyển bước.
- completed: học sinh đã tự trình bày đầy đủ lời giải. Có thể xác nhận và tóm tắt chính lập luận mà học sinh đã nêu, không viết một lời giải mới thay em.

CẬP NHẬT HÌNH 3D:
- Nếu cần lấy thêm điểm, nối đường, tô mặt hoặc biểu diễn một quan hệ để phục vụ bước đang học, giải thích mục đích trong answer rồi trả về đúng một bản vá nhỏ trong geometry_patch.
- Chỉ cập nhật hình khi student_status là no_attempt hoặc correct. Với partially_correct/incorrect/completed, should_update_geometry=false và mọi mảng trong geometry_patch phải rỗng.
- Mỗi lượt chỉ thêm hoặc đổi nhiều nhất MỘT cấu dựng sư phạm (một điểm kèm các đoạn thiết yếu được tính là một cấu dựng). Không xóa hay làm mất hình gốc.
- Điểm/đường/mặt phụ dùng màu khác hình gốc theo quy tắc dựng hình. Không đưa vào hình yếu tố của bước tương lai.
- Nếu không cần thay đổi hình hoặc chưa có mô hình, should_update_geometry=false và trả bản vá rỗng.

TRÌNH BÀY:
- answer bằng tiếng Việt, Markdown ngắn gọn, tự nhiên như hội thoại; không cần tiêu đề nếu một đoạn văn là đủ.
- Mọi biểu thức toán đặt trong \( ... \) hoặc \[ ... \]. Dùng LaTeX chuẩn như \parallel, \perp, \in, \cap, \triangle.
- Không dùng mục “Kết luận”, không đóng khung đáp án, không thêm lời mời chung chung.

Quy tắc dữ liệu bản vá hình:
${patchInstructions}`,
        input: `Đề bài gốc:\n${originalProblem || "Chưa có đề gốc."}\n\nMô hình hiện tại:\n${currentGeometry ? JSON.stringify(currentGeometry) : "Chưa có mô hình."}\n\nLịch sử học tập gần nhất:\n${conversation.length ? JSON.stringify(conversation) : "Chưa có."}\n\nTin nhắn mới nhất của học sinh:\n${message}`,
        text: {
          format: {
            type: "json_schema",
            name: "socratic_tutor_step",
            strict: true,
            schema: tutorStepSchema,
          },
        },
      }),
    });

    const data = await openaiResponse.json();
    if (!openaiResponse.ok) {
      sendJson(response, openaiResponse.status, {
        error: data?.error?.message || "OpenAI không thể trả lời lúc này.",
      });
      return;
    }

    const outputText = data.output
      ?.flatMap((item) => item.content || [])
      .find((content) => content.type === "output_text")?.text;
    if (!outputText) throw new Error("AI không trả về bước hướng dẫn.");

    const tutorStep = JSON.parse(outputText);
    const canAdvance = ["no_attempt", "correct"].includes(tutorStep.student_status);
    const shouldUpdateGeometry = Boolean(
      currentGeometry
      && canAdvance
      && tutorStep.should_update_geometry,
    );
    const guidingQuestion = normalizeTutorMathControls(
      tutorStep.guiding_question || "Em sẽ bắt đầu suy luận từ dữ kiện nào?",
    )
      .trim()
      .replace(/[?.!。！？]*$/, "?");
    const tutorAnswer = normalizeTutorMathControls(tutorStep.answer || "").trim();
    const answer = `${tutorAnswer}\n\n### Câu hỏi cho em\n${guidingQuestion}`.trim();
    const patchedGeometry = shouldUpdateGeometry
      ? applyGeometryPatch(currentGeometry, tutorStep.geometry_patch)
      : currentGeometry;
    const relationContext = [
      originalProblem,
      message,
      tutorAnswer,
      tutorStep.geometry_patch?.assistant_message,
    ].filter(Boolean).join("\n");
    const geometry = patchedGeometry
      ? enforceGeometryRelations(relationContext, patchedGeometry)
      : patchedGeometry;

    sendJson(response, 200, {
      answer,
      student_status: tutorStep.student_status,
      geometry,
      geometry_updated: shouldUpdateGeometry,
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Không thể trả lời." });
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

  if (request.method === "POST" && request.url === "/api/geometry/repair") {
    await handleGeometryRepairRequest(request, response);
    return;
  }

  if (request.method === "POST" && request.url === "/api/explain") {
    await handleExplainRequest(request, response);
    return;
  }

  if (request.method === "POST" && request.url === "/api/ocr") {
    await handleOcrRequest(request, response);
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
