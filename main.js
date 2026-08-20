import "./style.css";
import * as THREE from "three";
import katex from "katex";
import "katex/dist/katex.min.css";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

const canvasWrap = document.querySelector("#canvas-wrap");
const problemInput = document.querySelector("#problem-input");
const drawButton = document.querySelector("#draw-button");
const explainButton = document.querySelector("#explain-button");
const resetButton = document.querySelector("#reset-view");
const gridButton = document.querySelector("#toggle-grid");
const status = document.querySelector("#shape-status");
const parserNote = document.querySelector("#parser-note");
const chatLog = document.querySelector("#chat-log");
const buttonLabel = drawButton.querySelector(".button-label");
const explainLabel = explainButton.querySelector(".explain-label");
const newProblemButton = document.querySelector("#new-problem");
const mathSymbolButtons = document.querySelectorAll("[data-symbol]");
const defaultProblem = problemInput.value;
const storageKey = "geospace-current-problem-v1";
let currentSession = createEmptySession();
let statusBeforeLoading = "Sẵn sàng";

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
canvasWrap.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = "label-layer";
canvasWrap.appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance = 5;
controls.maxDistance = 22;
controls.maxPolarAngle = Math.PI * 0.84;

scene.add(new THREE.HemisphereLight(0xffffff, 0xc7c1ad, 2.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.7);
keyLight.position.set(4, 8, 6);
scene.add(keyLight);

const grid = new THREE.GridHelper(16, 16, 0xaeb7ae, 0xd8d8ce);
grid.position.y = -1.75;
grid.material.transparent = true;
grid.material.opacity = 0.45;
scene.add(grid);

const figureGroup = new THREE.Group();
scene.add(figureGroup);

let edgeLayer = new THREE.Group();
figureGroup.add(edgeLayer);

const edgeDefinitions = [];
const occluderMeshes = [];
const raycaster = new THREE.Raycaster();
const rayDirection = new THREE.Vector3();
let edgeVisibilityDirty = true;

const colors = {
  edge: 0x33463b,
  accent: 0xd3643f,
  helper: 0x89a095,
  face: 0xcfdcd1,
  point: 0xf8f5ed,
};

const colorPalette = {
  orange: 0xd3643f,
  blue: 0x3478c8,
  purple: 0x7656c9,
  green: 0x33835d,
  red: 0xc94949,
  yellow: 0xd69b22,
  pink: 0xc84f87,
  cyan: 0x238d99,
};

function resolveGeometryColor(name, fallback) {
  return colorPalette[name] ?? fallback;
}

function makeLine(start, end, options = {}) {
  edgeDefinitions.push({
    start: start.clone(),
    end: end.clone(),
    color: options.color ?? colors.edge,
    opacity: options.opacity ?? 0.92,
  });
  edgeVisibilityDirty = true;
}

function makeOccluder(pointNames, points) {
  const vertices = pointNames.flatMap((name) => points[name].toArray());
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();

  // Mặt này không được vẽ ra; nó chỉ dùng để kiểm tra tia nhìn từ camera.
  const material = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0,
    colorWrite: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  figureGroup.add(mesh);
  occluderMeshes.push(mesh);
}

function disposeChildren(group) {
  group.traverse((child) => {
    if (child === group) return;
    child.element?.remove();
    child.geometry?.dispose();
    if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
    else child.material?.dispose();
  });
  group.clear();
}

function isOccluded(point) {
  rayDirection.copy(point).sub(camera.position);
  const pointDistance = rayDirection.length();
  if (pointDistance < 0.05) return false;

  raycaster.set(camera.position, rayDirection.normalize());
  raycaster.near = 0.05;
  raycaster.far = Math.max(0.05, pointDistance - 0.035);
  return raycaster.intersectObjects(occluderMeshes, false).length > 0;
}

function addStyledSegment(start, end, hidden, definition) {
  if (start.distanceToSquared(end) < 0.000001) return;

  const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  const material = hidden
    ? new THREE.LineDashedMaterial({
        color: definition.color,
        dashSize: 0.14,
        gapSize: 0.1,
        transparent: true,
        opacity: 0.54,
        depthTest: false,
      })
    : new THREE.LineBasicMaterial({
        color: definition.color,
        transparent: true,
        opacity: definition.opacity,
        depthTest: false,
      });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = hidden ? 2 : 3;
  if (hidden) line.computeLineDistances();
  edgeLayer.add(line);
}

function renderDynamicEdges() {
  disposeChildren(edgeLayer);
  if (!edgeDefinitions.length) return;

  if (!occluderMeshes.length) {
    edgeDefinitions.forEach((definition) => {
      addStyledSegment(definition.start, definition.end, false, definition);
    });
    return;
  }

  camera.updateMatrixWorld();
  figureGroup.updateMatrixWorld(true);
  const samples = 36;
  const samplePoint = new THREE.Vector3();

  edgeDefinitions.forEach((definition) => {
    let runStart = 0;
    samplePoint.lerpVectors(definition.start, definition.end, 0.5 / samples);
    let runHidden = isOccluded(samplePoint);

    for (let index = 1; index <= samples; index += 1) {
      const nextHidden = index < samples
        ? isOccluded(samplePoint.lerpVectors(definition.start, definition.end, (index + 0.5) / samples))
        : null;

      if (index === samples || nextHidden !== runHidden) {
        const start = new THREE.Vector3().lerpVectors(definition.start, definition.end, runStart / samples);
        const end = new THREE.Vector3().lerpVectors(definition.start, definition.end, index / samples);
        addStyledSegment(start, end, runHidden, definition);
        runStart = index;
        runHidden = nextHidden;
      }
    }
  });
}

function makeFace(pointNames, points, options = {}) {
  const vertices = pointNames.flatMap((name) => points[name].toArray());
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  const face = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: options.color ?? colors.face,
      transparent: true,
      opacity: options.opacity ?? 0.17,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  figureGroup.add(face);
}

function makePoint(name, position, accent = false, colorName = "default") {
  const pointColor = resolveGeometryColor(colorName, accent ? colors.accent : colors.point);
  const point = new THREE.Mesh(
    new THREE.SphereGeometry(accent ? 0.105 : 0.085, 20, 20),
    new THREE.MeshStandardMaterial({
      color: pointColor,
      emissive: accent ? new THREE.Color(pointColor).multiplyScalar(0.24) : 0x000000,
      emissiveIntensity: 0.1,
      roughness: 0.42,
    }),
  );
  point.position.copy(position);
  figureGroup.add(point);

  const labelElement = document.createElement("div");
  labelElement.className = "point-label";
  labelElement.textContent = name;
  if (accent || colorName !== "default") {
    labelElement.classList.add("is-auxiliary");
    labelElement.style.setProperty("--point-color", `#${new THREE.Color(pointColor).getHexString()}`);
  }
  const label = new CSS2DObject(labelElement);
  label.position.copy(position);
  figureGroup.add(label);
}

function clearFigure() {
  disposeChildren(figureGroup);
  edgeDefinitions.length = 0;
  occluderMeshes.length = 0;
  edgeLayer = new THREE.Group();
  figureGroup.add(edgeLayer);
}

function drawEdges(edges, points) {
  edges.forEach(([a, b]) => makeLine(points[a], points[b]));
}

function buildPyramid(text) {
  const points = {
    A: new THREE.Vector3(-2.25, -1.35, 1.55),
    B: new THREE.Vector3(1.25, -1.35, 1.55),
    C: new THREE.Vector3(2.15, -1.35, -1.1),
    D: new THREE.Vector3(-1.3, -1.35, -1.1),
    S: new THREE.Vector3(-0.15, 2.35, -0.15),
  };
  const edges = [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"], ["S", "A"], ["S", "B"], ["S", "C"], ["S", "D"]];
  drawEdges(edges, points);
  makeOccluder([
    "A", "B", "C", "A", "C", "D",
    "S", "A", "B", "S", "B", "C",
    "S", "C", "D", "S", "D", "A",
  ], points);
  makeFace(["A", "B", "C", "A", "C", "D"], points);
  makeFace(["S", "A", "B"], points);

  if (/\bM\b/i.test(text) || /trung điểm của AB/i.test(text)) {
    points.M = points.A.clone().lerp(points.B, 0.5);
    makePoint("M", points.M, true);
    if (/\bSM\b/i.test(text) || /nối SM/i.test(text)) makeLine(points.S, points.M, { color: colors.accent });
  }
  if (/\bAC\b/i.test(text) || /nối AC/i.test(text)) makeLine(points.A, points.C, { color: colors.accent });
  Object.entries(points).filter(([name]) => name !== "M").forEach(([name, point]) => makePoint(name, point, name === "S"));
  return { label: "Hình chóp", message: "Đã nhận diện hình chóp S.ABCD và các yếu tố được nêu trong đề." };
}

function buildTetrahedron(text) {
  const points = {
    A: new THREE.Vector3(-2.1, -1.35, 1.3),
    B: new THREE.Vector3(1.9, -1.35, 1.2),
    C: new THREE.Vector3(0.9, -1.35, -1.65),
    D: new THREE.Vector3(-0.15, 2.15, -0.2),
  };
  drawEdges([["A", "B"], ["B", "C"], ["C", "A"], ["D", "A"], ["D", "B"], ["D", "C"]], points);
  makeOccluder([
    "A", "B", "C",
    "A", "D", "B",
    "B", "D", "C",
    "C", "D", "A",
  ], points);
  makeFace(["A", "B", "D"], points);
  makeFace(["B", "C", "D"], points);

  if (/\bM\b/i.test(text) || /trung điểm của AB/i.test(text)) {
    points.M = points.A.clone().lerp(points.B, 0.5);
    makePoint("M", points.M, true);
  }
  if (/\bN\b/i.test(text) || /trung điểm của CD/i.test(text)) {
    points.N = points.C.clone().lerp(points.D, 0.5);
    makePoint("N", points.N, true);
  }
  if (points.M && points.N) makeLine(points.M, points.N, { color: colors.accent });
  Object.entries(points).filter(([name]) => !["M", "N"].includes(name)).forEach(([name, point]) => makePoint(name, point, name === "D"));
  return { label: "Tứ diện", message: "Đã nhận diện tứ diện ABCD và dựng các trung điểm trong đề." };
}

function buildCube(text) {
  const points = {
    A: new THREE.Vector3(-1.8, -1.45, 1.2), B: new THREE.Vector3(1.25, -1.45, 1.2),
    C: new THREE.Vector3(2.05, -1.45, -1.25), D: new THREE.Vector3(-1.0, -1.45, -1.25),
    "A′": new THREE.Vector3(-1.8, 1.35, 1.2), "B′": new THREE.Vector3(1.25, 1.35, 1.2),
    "C′": new THREE.Vector3(2.05, 1.35, -1.25), "D′": new THREE.Vector3(-1.0, 1.35, -1.25),
  };
  const edges = [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"], ["A′", "B′"], ["B′", "C′"], ["C′", "D′"], ["D′", "A′"], ["A", "A′"], ["B", "B′"], ["C", "C′"], ["D", "D′"]];
  drawEdges(edges, points);
  makeOccluder([
    "A", "B", "C", "A", "C", "D",
    "A′", "C′", "B′", "A′", "D′", "C′",
    "A", "A′", "B′", "A", "B′", "B",
    "B", "B′", "C′", "B", "C′", "C",
    "C", "C′", "D′", "C", "D′", "D",
    "D", "D′", "A′", "D", "A′", "A",
  ], points);
  makeFace(["A′", "B′", "C′", "A′", "C′", "D′"], points);
  if (/\bAC\b/i.test(text)) makeLine(points.A, points.C, { color: colors.accent });
  if (/A['’′]C['’′]/i.test(text)) makeLine(points["A′"], points["C′"], { color: colors.accent });
  Object.entries(points).forEach(([name, point]) => makePoint(name, point, name.includes("′")));
  return { label: "Hình hộp", message: "Đã nhận diện hình hộp ABCD.A′B′C′D′ và các đường chéo được nêu." };
}

function triangulateFace(vertices) {
  const triangles = [];
  for (let index = 1; index < vertices.length - 1; index += 1) {
    triangles.push(vertices[0], vertices[index], vertices[index + 1]);
  }
  return triangles;
}

function fitCameraToPoints(points) {
  const positions = Object.values(points);
  if (!positions.length) return;
  const box = new THREE.Box3().setFromPoints(positions);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 1) * 0.62;
  const direction = new THREE.Vector3(0.63, 0.48, 0.72).normalize();
  const distance = Math.max(6, radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 1.15);

  camera.position.copy(center).addScaledVector(direction, distance);
  controls.target.copy(center);
  controls.minDistance = Math.max(2.5, radius * 0.8);
  controls.maxDistance = Math.max(18, radius * 7);
  grid.position.y = box.min.y - Math.max(0.35, size.y * 0.08);
  controls.update();
}

function buildAiGeometry(geometry) {
  if (!geometry || !Array.isArray(geometry.points) || !Array.isArray(geometry.edges) || !Array.isArray(geometry.faces)) {
    throw new Error("Mô hình AI trả về không hợp lệ.");
  }

  clearFigure();
  const points = {};

  geometry.points.forEach((point) => {
    const label = String(point.label || "").trim();
    const coordinates = [point.x, point.y, point.z].map(Number);
    if (!label || points[label] || coordinates.some((value) => !Number.isFinite(value))) return;
    points[label] = new THREE.Vector3(...coordinates);
  });

  if (Object.keys(points).length < 3) throw new Error("AI chưa xác định đủ điểm để dựng hình.");

  geometry.faces.forEach((face) => {
    const vertices = face.vertices?.filter((label) => points[label]);
    if (!vertices || vertices.length < 3) return;
    const triangles = triangulateFace(vertices);
    makeOccluder(triangles, points);
    if (face.visible) {
      const isColored = face.color && face.color !== "default";
      makeFace(triangles, points, {
        color: resolveGeometryColor(face.color, colors.face),
        opacity: isColored ? 0.28 : 0.17,
      });
    }
  });

  geometry.edges.forEach((edge) => {
    if (!points[edge.from] || !points[edge.to] || edge.from === edge.to) return;
    makeLine(points[edge.from], points[edge.to], {
      color: resolveGeometryColor(edge.color, edge.accent ? colors.accent : colors.edge),
      opacity: edge.accent ? 1 : 0.92,
    });
  });

  geometry.points.forEach((point) => {
    if (points[point.label]) makePoint(point.label, points[point.label], point.accent, point.color);
  });

  if (!edgeDefinitions.length) throw new Error("AI chưa xác định được các cạnh của hình.");

  fitCameraToPoints(points);
  renderDynamicEdges();
  edgeVisibilityDirty = false;
  status.textContent = geometry.title || "Hình đã dựng";
  parserNote.textContent = "AI đã dựng xong. Nét khuất tự đổi khi xoay hình.";
}

function drawLocally(text) {
  clearFigure();
  let result;
  if (/hình hộp|lập phương|lăng trụ/i.test(text)) result = buildCube(text);
  else if (/tứ diện/i.test(text)) result = buildTetrahedron(text);
  else result = buildPyramid(text);
  status.textContent = result.label;
  parserNote.textContent = `${result.message} Nét khuất tự đổi khi xoay hình.`;
  renderDynamicEdges();
  edgeVisibilityDirty = false;
}

function createEmptySession() {
  return {
    originalProblem: "",
    responseId: null,
    geometry: null,
    messages: [],
    updatedAt: null,
  };
}

function saveSession() {
  try {
    if (currentSession.geometry) localStorage.setItem(storageKey, JSON.stringify(currentSession));
    else localStorage.removeItem(storageKey);
  } catch {
    parserNote.textContent = "Không thể lưu ngữ cảnh trên thiết bị này.";
  }
}

function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (!saved?.geometry || !Array.isArray(saved.messages)) return false;
    currentSession = {
      originalProblem: String(saved.originalProblem || ""),
      responseId: typeof saved.responseId === "string" ? saved.responseId : null,
      geometry: saved.geometry,
      messages: saved.messages.filter((message) => message?.text && ["user", "assistant"].includes(message.type)),
      updatedAt: saved.updatedAt || null,
    };
    return true;
  } catch {
    return false;
  }
}

function resetChat() {
  chatLog.innerHTML = "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeLegacyMath(value) {
  return value
    .replace(/(?<!\\)\(([^()\n]*\\(?:parallel|perp|in|cap|triangle|angle|subset|notin|neq|cong|sim|frac|sqrt)[^()\n]*)\)/g, "\\($1\\)")
    .replace(/(?<!\\)\(([A-Z][A-Z0-9.′'’]*)\)/g, "\\($1\\)");
}

function normalizeGeometryMath(value) {
  return normalizeLegacyMath(String(value))
    .replace(/\\{2,}(?=[A-Za-z()[\]\s])/g, "\\")
    .replace(/\\\s+([()[\]])/g, "\\$1")
    .replace(/\b([A-Z][A-Z0-9′'’]*)\s*(?:\/\/|∥)\s*([A-Z][A-Z0-9′'’]*)\b/g, "\\($1 \\parallel $2\\)")
    .replace(/\b([A-Z][A-Z0-9′'’]*)\s*⊥\s*([A-Z][A-Z0-9′'’]*)\b/g, "\\($1 \\perp $2\\)")
    .replace(/\b([A-Z][A-Z0-9′'’]*)\s*∈\s*([A-Z][A-Z0-9′'’]*)\b/g, "\\($1 \\in $2\\)");
}

function renderPlainText(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderInlineMath(value) {
  const source = normalizeGeometryMath(value);
  const pattern = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\$([^$\n]+?)\$/g;
  let html = "";
  let cursor = 0;

  for (const match of source.matchAll(pattern)) {
    html += renderPlainText(source.slice(cursor, match.index));
    const expression = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "")
      .trim()
      .replace(/^\\(?=\s|$)/, "")
      .replace(/\\$/, "")
      .trim();
    const displayMode = match[2] !== undefined || match[3] !== undefined;
    html += katex.renderToString(expression.trim(), {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml",
    });
    cursor = match.index + match[0].length;
  }

  return html + renderPlainText(source.slice(cursor));
}

function renderChatContent(value) {
  const source = normalizeGeometryMath(value)
    .replace(/\s+(#{1,6}\s+(?:\d+[.)]?\s*)?)/g, "\n\n$1")
    .trim();
  if (!source) return "";

  const output = [];
  let paragraph = [];
  let listType = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(renderInlineMath).join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = null;
  };

  source.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      closeList();
      return;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length + 2, 6);
      output.push(`<h${level}>${renderInlineMath(heading[2])}</h${level}>`);
      return;
    }

    const unordered = line.match(/^[-•*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextListType = ordered ? "ol" : "ul";
      if (listType !== nextListType) {
        closeList();
        output.push(`<${nextListType}>`);
        listType = nextListType;
      }
      output.push(`<li>${renderInlineMath((ordered || unordered)[1])}</li>`);
      return;
    }

    closeList();
    paragraph.push(line);
  });

  flushParagraph();
  closeList();
  return output.join("");
}

function appendMessage(text, type, record = true) {
  const message = document.createElement("div");
  message.className = `chat-message ${type}-message`;
  const avatar = document.createElement("span");
  avatar.className = "chat-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = type === "assistant" ? "AI" : "B";
  const content = document.createElement("div");
  content.className = "chat-content";
  content.innerHTML = renderChatContent(text);
  message.append(avatar, content);
  chatLog.appendChild(message);
  chatLog.scrollTop = chatLog.scrollHeight;
  if (record) {
    currentSession.messages.push({ text, type });
    currentSession.updatedAt = new Date().toISOString();
    saveSession();
  }
}

function setLoading(loading, action = "draw") {
  drawButton.disabled = loading;
  explainButton.disabled = loading;
  newProblemButton.disabled = loading;
  drawButton.classList.toggle("is-loading", loading && action === "draw");
  explainButton.classList.toggle("is-loading", loading && action === "explain");
  buttonLabel.textContent = loading && action === "draw" ? "Đang dựng…" : "Dựng hình";
  explainLabel.textContent = loading && action === "explain" ? "Đang giảng…" : "Giảng bài";
  if (loading) {
    statusBeforeLoading = status.textContent;
    status.textContent = action === "draw" ? "Đang dựng hình…" : "Đang giảng bài…";
  } else if (status.textContent.startsWith("Đang ")) {
    status.textContent = statusBeforeLoading;
  }
}

function updateComposerForContext() {
  problemInput.placeholder = "Nhập đề bài hoặc câu hỏi…";
  buttonLabel.textContent = "Dựng hình";
  explainLabel.textContent = "Giảng bài";
}

function startNewProblem(focusInput = true) {
  currentSession = createEmptySession();
  saveSession();
  clearFigure();
  resetChat();
  problemInput.value = "";
  status.textContent = "Sẵn sàng";
  parserNote.textContent = "Đã xóa ngữ cảnh cũ. Hãy nhập đề bài mới.";
  grid.position.y = -1.75;
  updateComposerForContext();
  if (focusInput) problemInput.focus();
}

function restoreSavedProblem() {
  if (!loadSession()) return false;
  resetChat();
  currentSession.messages.forEach((message) => appendMessage(message.text, message.type, false));
  buildAiGeometry(currentSession.geometry);
  problemInput.value = "";
  parserNote.textContent = "Đã khôi phục ngữ cảnh bài đang làm. Bạn có thể yêu cầu xóa hoặc vẽ thêm.";
  updateComposerForContext();
  return true;
}

async function submitProblem() {
  const text = problemInput.value.trim();
  if (!text) {
    parserNote.textContent = "Hãy nhập một đề bài để bắt đầu dựng hình.";
    problemInput.focus();
    return;
  }

  problemInput.value = "";
  const hasContext = Boolean(currentSession.geometry);
  appendMessage(text, "user");
  setLoading(true, "draw");
  parserNote.textContent = hasContext
    ? "AI đang chỉnh sửa hình hiện tại và giữ nguyên các phần không liên quan…"
    : "AI đang xác định điểm, cạnh, mặt và các quan hệ hình học…";

  try {
    const response = await fetch("/api/geometry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        original_problem: currentSession.originalProblem,
        previous_response_id: currentSession.responseId,
        current_geometry: currentSession.geometry,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Không thể kết nối với trợ lý AI.");

    buildAiGeometry(data.geometry);
    currentSession.originalProblem ||= text;
    currentSession.geometry = data.geometry;
    currentSession.responseId = data.response_id || null;
    currentSession.updatedAt = new Date().toISOString();
    appendMessage(data.geometry.assistant_message || "Mình đã dựng xong hình từ đề bài.", "assistant");
    saveSession();
    updateComposerForContext();
  } catch (error) {
    if (hasContext) {
      appendMessage(`${error.message} Hình trước đó vẫn được giữ nguyên; bạn có thể gửi lại yêu cầu.`, "assistant");
      parserNote.textContent = "Không cập nhật được; ngữ cảnh và hình trước đó vẫn còn nguyên.";
    } else {
      drawLocally(text);
      appendMessage(`${error.message} Mình đã dùng bộ dựng cục bộ cho hình hiện tại.`, "assistant");
      parserNote.textContent = "Không gọi được AI; đang hiển thị bản dựng cục bộ.";
    }
  } finally {
    setLoading(false);
  }
}

async function explainProblem() {
  const text = problemInput.value.trim();
  const question = text || (currentSession.originalProblem ? "Giảng bài này" : "");
  if (!question) {
    parserNote.textContent = "Hãy nhập đề bài hoặc câu hỏi cần giảng.";
    problemInput.focus();
    return;
  }

  problemInput.value = "";
  appendMessage(question, "user");
  setLoading(true, "explain");
  parserNote.textContent = "AI đang giảng bài…";

  try {
    const response = await fetch("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: question,
        original_problem: currentSession.originalProblem,
        current_geometry: currentSession.geometry,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Không thể kết nối với trợ lý AI.");
    appendMessage(data.answer, "assistant");
    parserNote.textContent = "Đã trả lời xong.";
  } catch (error) {
    appendMessage(error.message, "assistant");
    parserNote.textContent = "Không thể giảng bài lúc này.";
  } finally {
    setLoading(false, "explain");
  }
}

function resetView() {
  camera.position.set(7.2, 5.6, 8.4);
  controls.target.set(0, 0.1, 0);
  controls.update();
}

function resize() {
  const { clientWidth, clientHeight } = canvasWrap;
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(clientWidth, clientHeight);
  labelRenderer.setSize(clientWidth, clientHeight);
  edgeVisibilityDirty = true;
}

function insertMathSymbol(symbol) {
  const start = problemInput.selectionStart ?? problemInput.value.length;
  const end = problemInput.selectionEnd ?? start;
  problemInput.setRangeText(symbol, start, end, "end");
  problemInput.focus();
  problemInput.dispatchEvent(new Event("input", { bubbles: true }));
}

drawButton.addEventListener("click", submitProblem);
explainButton.addEventListener("click", explainProblem);
newProblemButton.addEventListener("click", () => startNewProblem());
mathSymbolButtons.forEach((button) => {
  button.addEventListener("click", () => insertMathSymbol(button.dataset.symbol || ""));
});
problemInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submitProblem();
});
resetButton.addEventListener("click", resetView);
gridButton.addEventListener("click", () => {
  grid.visible = !grid.visible;
  gridButton.setAttribute("aria-pressed", String(grid.visible));
});
controls.addEventListener("change", () => {
  edgeVisibilityDirty = true;
});
window.addEventListener("resize", resize);
resetView();
resize();
if (!restoreSavedProblem()) {
  resetChat();
  if (defaultProblem.trim()) drawLocally(defaultProblem);
  else {
    clearFigure();
    status.textContent = "Sẵn sàng";
  }
  updateComposerForContext();
}

renderer.setAnimationLoop(() => {
  controls.update();
  if (edgeVisibilityDirty) {
    renderDynamicEdges();
    edgeVisibilityDirty = false;
  }
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});
