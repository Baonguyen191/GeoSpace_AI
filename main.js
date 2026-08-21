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
const explainIcon = explainButton.querySelector("span:first-child");
const newProblemButton = document.querySelector("#new-problem");
const mathSymbolButtons = document.querySelectorAll("[data-symbol]");
const mathToggleButton = document.querySelector("#math-toggle");
const mathPopover = document.querySelector("#math-popover");
const problemImageInput = document.querySelector("#problem-image");
const imageUploadButton = document.querySelector(".image-upload-button");
const imageUploadLabel = document.querySelector("#image-upload-label");
const ocrPreview = document.querySelector("#ocr-preview");
const ocrPreviewImage = document.querySelector("#ocr-preview-image");
const ocrFileName = document.querySelector("#ocr-file-name");
const ocrStatus = document.querySelector("#ocr-status");
const removeImageButton = document.querySelector("#remove-image");
const motionControls = document.querySelector("#motion-controls");
const motionControlList = document.querySelector("#motion-control-list");
const problemStatement = document.querySelector("#problem-statement");
const problemStatementContent = document.querySelector("#problem-statement-content");
const problemToggle = document.querySelector("#problem-toggle");
const measurementPanel = document.querySelector("#measurement-panel");
const measurementSheetBody = document.querySelector("#measurement-sheet-body");
const measurementStatus = document.querySelector("#measurement-status");
const measurementToggle = document.querySelector("#toggle-measurements");
const measurementClose = document.querySelector("#close-measurements");
const measurementCount = document.querySelector("#measurement-count");
const defaultProblem = problemInput.value;
const storageKey = "geospace-current-problem-v1";
let currentSession = createEmptySession();
let problemExpanded = false;
let measurementPanelOpen = false;
let statusBeforeLoading = "Sẵn sàng";
let ocrPreviewUrl = null;
let ocrController = null;

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
  const distance = Math.max(6, radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 1.32);

  camera.position.copy(center).addScaledVector(direction, distance);
  controls.target.copy(center);
  controls.minDistance = Math.max(2.5, radius * 0.8);
  controls.maxDistance = Math.max(18, radius * 7);
  grid.position.y = box.min.y - Math.max(0.35, size.y * 0.08);
  controls.update();
}

function getMovablePoints(geometry) {
  const labels = new Set((geometry.points || []).map((point) => point.label));
  return (geometry.points || []).filter((point) => (
    point.movable
    && point.path_from
    && point.path_to
    && point.path_from !== point.path_to
    && point.label !== point.path_from
    && point.label !== point.path_to
    && labels.has(point.path_from)
    && labels.has(point.path_to)
  ));
}

function setPointOnMovementPath(geometry, point, ratio) {
  const from = geometry.points.find((candidate) => candidate.label === point.path_from);
  const to = geometry.points.find((candidate) => candidate.label === point.path_to);
  if (!from || !to) return false;

  const safeRatio = THREE.MathUtils.clamp(Number(ratio) || 0, 0, 1);
  point.position_ratio = safeRatio;
  point.x = THREE.MathUtils.lerp(Number(from.x), Number(to.x), safeRatio);
  point.y = THREE.MathUtils.lerp(Number(from.y), Number(to.y), safeRatio);
  point.z = THREE.MathUtils.lerp(Number(from.z), Number(to.z), safeRatio);
  return true;
}

function clearMotionControls() {
  motionControlList.replaceChildren();
  motionControls.hidden = true;
}

function updateProblemStatement() {
  const problem = String(currentSession.originalProblem || "").trim();
  problemStatement.hidden = !problem;
  problemStatementContent.innerHTML = problem ? renderChatContent(problem) : "";
  problemStatement.classList.toggle("is-expanded", problemExpanded);
  problemToggle.setAttribute("aria-expanded", String(problemExpanded));
  problemToggle.textContent = problemExpanded ? "Thu gọn" : "Mở rộng";
}

function getGeometryPoint(geometry, label) {
  return geometry.points.find((point) => point.label === label);
}

function geometryPointVector(point) {
  return new THREE.Vector3(Number(point.x), Number(point.y), Number(point.z));
}

function setGeometryPointVector(point, vector) {
  point.x = Number(vector.x.toFixed(6));
  point.y = Number(vector.y.toFixed(6));
  point.z = Number(vector.z.toFixed(6));
}

function getLengthTargets(geometry) {
  const seen = new Set();
  return geometry.edges.flatMap((edge) => {
    const from = getGeometryPoint(geometry, edge.from);
    const to = getGeometryPoint(geometry, edge.to);
    const key = [edge.from, edge.to].sort().join("|");
    if (!from || !to || from === to || seen.has(key)) return [];
    seen.add(key);
    return [{
      type: "length",
      label: `${edge.from}${edge.to}`,
      from: edge.from,
      to: edge.to,
    }];
  });
}

function getAngleTargets(geometry) {
  const neighbors = new Map();
  geometry.edges.forEach((edge) => {
    if (!getGeometryPoint(geometry, edge.from) || !getGeometryPoint(geometry, edge.to)) return;
    if (!neighbors.has(edge.from)) neighbors.set(edge.from, new Set());
    if (!neighbors.has(edge.to)) neighbors.set(edge.to, new Set());
    neighbors.get(edge.from).add(edge.to);
    neighbors.get(edge.to).add(edge.from);
  });

  const targets = [];
  neighbors.forEach((connectedLabels, vertex) => {
    const connected = [...connectedLabels].sort();
    for (let left = 0; left < connected.length; left += 1) {
      for (let right = left + 1; right < connected.length; right += 1) {
        targets.push({
          type: "angle",
          label: `∠${connected[left]}${vertex}${connected[right]}`,
          a: connected[left],
          vertex,
          c: connected[right],
        });
      }
    }
  });
  return targets.slice(0, 80);
}

function measurementTargetKey(target) {
  if (!target) return "";
  return target.type === "length"
    ? `length:${[target.from, target.to].sort().join("-")}`
    : `angle:${target.a}-${target.vertex}-${target.c}`;
}

function saveMeasurementConstraint(target, value) {
  const key = measurementTargetKey(target);
  const measurements = (currentSession.measurements || []).filter((measurement) => measurement.key !== key);
  measurements.push({ key, type: target.type, label: target.label, value });
  currentSession.measurements = measurements.slice(-80);
}

function getMeasurementContext() {
  if (!currentSession.measurements?.length) return "";
  const values = currentSession.measurements
    .map((measurement) => `${measurement.label} = ${measurement.value}${measurement.type === "angle" && !String(measurement.value).includes("°") ? "°" : ""}`)
    .join("; ");
  return `Số đo người dùng đã đặt: ${values}.`;
}

function getProblemWithMeasurements() {
  return [currentSession.originalProblem, getMeasurementContext()].filter(Boolean).join("\n");
}

function normalizeMeasurementLabel(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^GÓC\s*/u, "∠")
    .replace(/\s+/g, "");
}

function findMeasurementTarget(geometry, label) {
  const normalized = normalizeMeasurementLabel(label);
  const lengthTarget = getLengthTargets(geometry).find((target) => (
    normalizeMeasurementLabel(target.label) === normalized
    || normalizeMeasurementLabel(`${target.to}${target.from}`) === normalized
  ));
  if (lengthTarget) return lengthTarget;
  return getAngleTargets(geometry).find((target) => (
    normalizeMeasurementLabel(target.label) === normalized
    || normalizeMeasurementLabel(`∠${target.c}${target.vertex}${target.a}`) === normalized
  )) || null;
}

function renderMeasurementPanel(geometry) {
  const hasGeometry = Boolean(geometry?.points?.length && geometry?.edges?.length);
  measurementToggle.disabled = !hasGeometry;
  const count = currentSession.measurements?.length || 0;
  measurementCount.textContent = String(count);
  measurementCount.hidden = count === 0;
  measurementToggle.setAttribute("aria-expanded", String(hasGeometry && measurementPanelOpen));
  if (!hasGeometry || !measurementPanelOpen) {
    measurementPanel.hidden = true;
    return;
  }
  measurementPanel.hidden = false;
  measurementSheetBody.replaceChildren();
  const savedMeasurements = currentSession.measurements || [];
  const rowCount = Math.max(6, savedMeasurements.length + 1);

  for (let index = 0; index < rowCount; index += 1) {
    const savedMeasurement = savedMeasurements[index] || null;
    const row = document.createElement("tr");
    row.dataset.row = String(index);
    row.dataset.key = savedMeasurement?.key || "";
    const rowNumber = document.createElement("td");
    rowNumber.textContent = String(index + 1);
    const objectCell = document.createElement("td");
    const valueCell = document.createElement("td");
    const objectInput = document.createElement("input");
    objectInput.type = "text";
    objectInput.value = savedMeasurement?.label || "";
    objectInput.placeholder = index === savedMeasurements.length ? "AB hoặc ∠ABC" : "";
    objectInput.setAttribute("aria-label", `Đối tượng ở dòng ${index + 1}`);
    const valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.value = savedMeasurement
      ? `${savedMeasurement.value}${savedMeasurement.type === "angle" ? "°" : ""}`
      : "";
    valueInput.placeholder = index === savedMeasurements.length ? "a, a√2, 60°" : "";
    valueInput.setAttribute("aria-label", `Giá trị ở dòng ${index + 1}`);

    const commit = async () => {
      const saved = await commitMeasurementRow(row, objectInput, valueInput);
      return saved;
    };
    [objectInput, valueInput].forEach((input) => {
      input.addEventListener("change", commit);
      input.addEventListener("keydown", async (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const saved = await commit();
        if (!saved) return;
        measurementSheetBody
          .querySelector(`tr[data-row="${index + 1}"] input`)
          ?.focus();
      });
    });

    objectCell.appendChild(objectInput);
    valueCell.appendChild(valueInput);
    row.append(rowNumber, objectCell, valueCell);
    measurementSheetBody.appendChild(row);
  }
}

function updateLengthMeasurement(geometry, target, requestedLength) {
  const from = getGeometryPoint(geometry, target.from);
  const to = getGeometryPoint(geometry, target.to);
  if (!from || !to) return false;
  const origin = geometryPointVector(from);
  const direction = geometryPointVector(to).sub(origin);
  if (direction.lengthSq() < 1e-10) return false;
  setGeometryPointVector(to, origin.add(direction.normalize().multiplyScalar(requestedLength)));
  return true;
}

function updateAngleMeasurement(geometry, target, requestedAngle) {
  const a = getGeometryPoint(geometry, target.a);
  const vertex = getGeometryPoint(geometry, target.vertex);
  const c = getGeometryPoint(geometry, target.c);
  if (!a || !vertex || !c) return false;
  const vertexVector = geometryPointVector(vertex);
  const firstRay = geometryPointVector(a).sub(vertexVector).normalize();
  const currentSecondRay = geometryPointVector(c).sub(vertexVector);
  const secondRayLength = currentSecondRay.length();
  if (firstRay.lengthSq() < 1e-10 || secondRayLength < 1e-10) return false;

  const perpendicular = currentSecondRay.clone()
    .sub(firstRay.clone().multiplyScalar(currentSecondRay.dot(firstRay)));
  if (perpendicular.lengthSq() < 1e-10) {
    const fallback = Math.abs(firstRay.y) < 0.9
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
    perpendicular.copy(fallback.sub(firstRay.clone().multiplyScalar(fallback.dot(firstRay))));
  }
  perpendicular.normalize();
  const angle = THREE.MathUtils.degToRad(requestedAngle);
  const nextDirection = firstRay.multiplyScalar(Math.cos(angle))
    .add(perpendicular.multiplyScalar(Math.sin(angle)))
    .normalize();
  setGeometryPointVector(c, vertexVector.add(nextDirection.multiplyScalar(secondRayLength)));
  return true;
}

async function commitMeasurementRow(row, objectInput, valueInput) {
  const geometry = currentSession.geometry;
  const objectLabel = objectInput.value.trim();
  const rawValue = valueInput.value.trim().replace(/°+$/, "").trim();
  const previousKey = row.dataset.key;
  if (!objectLabel && !rawValue) {
    if (previousKey) {
      currentSession.measurements = currentSession.measurements
        .filter((measurement) => measurement.key !== previousKey);
      saveSession();
      renderMeasurementPanel(geometry);
      measurementStatus.textContent = "Đã xóa dòng số đo.";
    }
    return true;
  }
  if (!objectLabel || !rawValue) return false;

  const target = findMeasurementTarget(geometry, objectLabel);
  const numericText = rawValue.replace(",", ".");
  const isNumericValue = /^\d+(?:\.\d+)?$/.test(numericText);
  const numericValue = isNumericValue ? Number(numericText) : NaN;
  const validNumericValue = !isNumericValue
    || (target?.type === "length"
      ? numericValue > 0
      : numericValue > 0 && numericValue < 180);
  if (!geometry || !target || !rawValue || rawValue.length > 48 || !validNumericValue) {
    measurementStatus.textContent = !target
      ? "Đối tượng chưa có trong hình. Nhập như AB hoặc ∠ABC."
      : "Giá trị chưa hợp lệ; góc số phải nằm từ 1° đến 179°.";
    measurementStatus.classList.add("is-error");
    row.classList.add("is-invalid");
    return false;
  }

  if (previousKey && previousKey !== measurementTargetKey(target)) {
    currentSession.measurements = currentSession.measurements
      .filter((measurement) => measurement.key !== previousKey);
  }
  saveMeasurementConstraint(target, rawValue);
  currentSession.updatedAt = new Date().toISOString();
  row.classList.remove("is-invalid");

  if (!isNumericValue) {
    saveSession();
    renderMeasurementPanel(geometry);
    measurementStatus.textContent = `Đã lưu ${target.label} = ${rawValue} làm dữ kiện của bài.`;
    measurementStatus.classList.remove("is-error");
    parserNote.textContent = measurementStatus.textContent;
    return true;
  }

  const updated = target.type === "length"
    ? updateLengthMeasurement(geometry, target, numericValue)
    : updateAngleMeasurement(geometry, target, numericValue);
  if (!updated) return false;
  buildAiGeometry(geometry, { fitCamera: false, renderMeasurements: true, updateStatus: false });
  saveSession();
  measurementStatus.textContent = `Đã cập nhật ${target.label} = ${rawValue}${target.type === "angle" ? "°" : ""}.`;
  measurementStatus.classList.remove("is-error");
  parserNote.textContent = measurementStatus.textContent;

  try {
    const response = await fetch("/api/geometry/repair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        original_problem: getProblemWithMeasurements() || "Cập nhật số đo thủ công",
        current_geometry: geometry,
        relation_context: [
          currentSession.messages.map((message) => message.text).join("\n"),
          getMeasurementContext(),
        ].filter(Boolean).join("\n").slice(-12_000),
      }),
    });
    const data = await response.json();
    if (response.ok && data.geometry) {
      currentSession.geometry = data.geometry;
      buildAiGeometry(data.geometry, { fitCamera: false, updateStatus: false });
      saveSession();
      measurementStatus.textContent = `Đã cập nhật ${target.label} và tính lại các điểm phụ liên quan.`;
    }
  } catch {
    // Giữ bản cập nhật cục bộ nếu bước kiểm tra quan hệ không hoàn tất.
  }
  return true;
}

function renderMotionControls(geometry) {
  const movablePoints = getMovablePoints(geometry);
  motionControlList.replaceChildren();
  motionControls.hidden = movablePoints.length === 0;
  if (!movablePoints.length) return;

  movablePoints.forEach((point) => {
    const row = document.createElement("div");
    row.className = "motion-control-row";

    const meta = document.createElement("div");
    meta.className = "motion-control-meta";
    const label = document.createElement("label");
    label.htmlFor = `motion-${point.label}`;
    label.textContent = `${point.label} trên ${point.path_from}${point.path_to}`;
    const value = document.createElement("output");
    value.htmlFor = label.htmlFor;

    const range = document.createElement("input");
    range.id = label.htmlFor;
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.step = "1";
    range.value = String(Math.round(THREE.MathUtils.clamp(Number(point.position_ratio) || 0, 0, 1) * 100));
    range.setAttribute("aria-label", `Vị trí điểm ${point.label} trên đoạn ${point.path_from}${point.path_to}`);

    const endpoints = document.createElement("div");
    endpoints.className = "motion-endpoints";
    const fromLabel = document.createElement("span");
    fromLabel.textContent = point.path_from;
    const toLabel = document.createElement("span");
    toLabel.textContent = point.path_to;
    endpoints.append(fromLabel, toLabel);

    const updateValue = () => {
      const ratio = Number(range.value) / 100;
      value.textContent = `t = ${ratio.toFixed(2)}`;
      setPointOnMovementPath(geometry, point, ratio);
      buildAiGeometry(geometry, {
        fitCamera: false,
        renderControls: false,
        renderMeasurements: false,
        updateStatus: false,
      });
    };

    range.addEventListener("input", updateValue);
    range.addEventListener("change", () => {
      saveSession();
      parserNote.textContent = `Đã đặt ${point.label} tại t = ${(Number(range.value) / 100).toFixed(2)} trên ${point.path_from}${point.path_to}.`;
    });

    value.textContent = `t = ${(Number(range.value) / 100).toFixed(2)}`;
    meta.append(label, value);
    row.append(meta, range, endpoints);
    motionControlList.appendChild(row);
  });
}

function buildAiGeometry(geometry, options = {}) {
  if (!geometry || !Array.isArray(geometry.points) || !Array.isArray(geometry.edges) || !Array.isArray(geometry.faces)) {
    throw new Error("Mô hình AI trả về không hợp lệ.");
  }

  const {
    fitCamera = true,
    renderControls = true,
    renderMeasurements = true,
    updateStatus = true,
  } = options;

  getMovablePoints(geometry).forEach((point) => {
    setPointOnMovementPath(geometry, point, point.position_ratio ?? 0.5);
  });

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

  if (fitCamera) fitCameraToPoints(points);
  renderDynamicEdges();
  edgeVisibilityDirty = false;
  if (renderControls) renderMotionControls(geometry);
  if (renderMeasurements) renderMeasurementPanel(geometry);
  if (updateStatus) {
    status.textContent = geometry.title || "Hình đã dựng";
    parserNote.textContent = getMovablePoints(geometry).length
      ? "Kéo thanh điểm di động để khảo sát vị trí lớn nhất, nhỏ nhất."
      : "AI đã dựng xong. Nét khuất tự đổi khi xoay hình.";
  }
}

function drawLocally(text) {
  clearMotionControls();
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
    measurements: [],
    tutorActive: false,
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
    const lastSavedMessage = saved.messages.at(-1);
    const inferredTutorActive = lastSavedMessage?.type === "assistant"
      && /(?:Câu hỏi cho em|\?\s*$)/i.test(String(lastSavedMessage.text || ""));
    currentSession = {
      originalProblem: String(saved.originalProblem || ""),
      responseId: typeof saved.responseId === "string" ? saved.responseId : null,
      geometry: saved.geometry,
      messages: saved.messages
        .filter((message) => message?.text && ["user", "assistant"].includes(message.type))
        .map((message) => ({
          ...message,
          text: normalizeControlMathDelimiters(message.text),
        })),
      measurements: Array.isArray(saved.measurements)
        ? saved.measurements.filter((measurement) => (
          measurement
          && typeof measurement.key === "string"
          && ["length", "angle"].includes(measurement.type)
          && typeof measurement.label === "string"
          && typeof measurement.value === "string"
        )).slice(-80)
        : [],
      tutorActive: typeof saved.tutorActive === "boolean" ? saved.tutorActive : inferredTutorActive,
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

function normalizeControlMathDelimiters(value) {
  const wrapMath = (_match, expression) => {
    const cleanExpression = String(expression)
      .trim()
      .replace(/^\\?\(\s*/, "")
      .replace(/\s*\\?\)$/, "")
      .trim();
    return cleanExpression ? `\\(${cleanExpression}\\)` : "";
  };

  return String(value)
    // Một số phản hồi mô hình dùng ký tự điều khiển như cặp phân cách công thức.
    .replace(/[\u000E\u0010]([\s\S]*?)[\u000F\u0011]/g, wrapMath)
    // Cũng xử lý trường hợp mã điều khiển bị lưu thành chuỗi "\\u0010".
    .replace(/(?:\\u0010|\\x10)([\s\S]*?)(?:\\u0011|\\x11)/gi, wrapMath)
    // Xóa mọi ký tự điều khiển còn sót, nhưng giữ tab và xuống dòng.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFC\uFFFD]/g, "")
    .replace(/\\(?:u00(?:0[0-8BCEF]|1[0-9A-F])|x(?:0[0-8BCEF]|1[0-9A-F]|7F))/gi, "");
}

function normalizeGeometryMath(value) {
  return normalizeLegacyMath(normalizeControlMathDelimiters(value))
    .replace(/≡\s*([^≡\n]+?)\s*≡/g, "\\($1\\)")
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
  const safeText = normalizeControlMathDelimiters(text);
  const message = document.createElement("div");
  message.className = `chat-message ${type}-message`;
  const avatar = document.createElement("span");
  avatar.className = "chat-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = type === "assistant" ? "AI" : "B";
  const content = document.createElement("div");
  content.className = "chat-content";
  content.innerHTML = renderChatContent(safeText);
  message.append(avatar, content);
  chatLog.appendChild(message);
  chatLog.scrollTop = chatLog.scrollHeight;
  if (record) {
    currentSession.messages.push({ text: safeText, type });
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
  explainButton.classList.add("is-answer-mode");
  buttonLabel.textContent = loading && action === "draw" ? "Đang dựng…" : "Dựng hình";
  explainLabel.textContent = loading && action === "explain" ? "AI đang suy nghĩ" : "Gửi câu hỏi hoặc câu trả lời";
  explainIcon.textContent = "↑";
  explainButton.setAttribute("aria-label", explainLabel.textContent);
  if (loading) {
    statusBeforeLoading = status.textContent;
    status.textContent = action === "draw" ? "Đang dựng hình…" : "AI đang suy nghĩ…";
  } else if (status.textContent.startsWith("Đang ")) {
    status.textContent = statusBeforeLoading;
  }
}

function updateComposerForContext() {
  problemInput.placeholder = currentSession.tutorActive
    ? "Nhập câu trả lời hoặc hỏi thêm…"
    : "Hỏi AI về bài này…";
  buttonLabel.textContent = "Dựng hình";
  explainLabel.textContent = "Gửi câu hỏi hoặc câu trả lời";
  explainIcon.textContent = "↑";
  explainButton.setAttribute("aria-label", explainLabel.textContent);
  explainButton.classList.add("is-answer-mode");
}

function setOcrLoading(loading) {
  problemImageInput.disabled = loading;
  drawButton.disabled = loading;
  explainButton.disabled = loading;
  newProblemButton.disabled = loading;
  imageUploadButton.classList.toggle("is-reading", loading);
  imageUploadLabel.textContent = loading ? "Đang đọc…" : "Ảnh";
}

function clearOcrPreview(cancelRequest = true) {
  if (cancelRequest && ocrController) ocrController.abort();
  ocrController = null;
  if (ocrPreviewUrl) URL.revokeObjectURL(ocrPreviewUrl);
  ocrPreviewUrl = null;
  problemImageInput.value = "";
  ocrPreviewImage.removeAttribute("src");
  ocrFileName.textContent = "";
  ocrStatus.textContent = "Sẵn sàng đọc đề";
  ocrStatus.classList.remove("is-error");
  ocrPreview.hidden = true;
  setOcrLoading(false);
}

async function readProblemImage(file) {
  if (!file) return;
  const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!supportedTypes.has(file.type)) {
    status.textContent = "Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP";
    problemImageInput.value = "";
    return;
  }
  if (file.size > 12 * 1024 * 1024) {
    status.textContent = "Ảnh phải nhỏ hơn 12 MB";
    problemImageInput.value = "";
    return;
  }

  clearOcrPreview();
  ocrPreviewUrl = URL.createObjectURL(file);
  ocrPreviewImage.src = ocrPreviewUrl;
  ocrFileName.textContent = file.name;
  ocrStatus.textContent = "Chandra OCR 2 đang trích xuất đề bài…";
  ocrStatus.classList.remove("is-error");
  ocrPreview.hidden = false;

  const controller = new AbortController();
  ocrController = controller;
  setOcrLoading(true);

  try {
    const form = new FormData();
    form.append("image", file, file.name);
    const response = await fetch("/api/ocr", {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Không thể đọc đề bài từ ảnh.");

    problemInput.value = String(data.text || "").trim();
    problemInput.dispatchEvent(new Event("input", { bubbles: true }));
    ocrStatus.textContent = "Đã trích xuất đề bài — có thể chỉnh sửa trước khi gửi";
    status.textContent = "Đã đọc đề từ ảnh";
    problemInput.focus();
  } catch (error) {
    if (error.name === "AbortError") return;
    ocrStatus.textContent = error.message || "Không thể đọc đề bài từ ảnh.";
    ocrStatus.classList.add("is-error");
    status.textContent = "OCR chưa hoàn tất";
  } finally {
    if (ocrController === controller) {
      ocrController = null;
      setOcrLoading(false);
    }
  }
}

function startNewProblem(focusInput = true) {
  clearOcrPreview();
  problemExpanded = false;
  measurementPanelOpen = false;
  currentSession = createEmptySession();
  saveSession();
  clearFigure();
  clearMotionControls();
  measurementPanel.hidden = true;
  measurementToggle.disabled = true;
  measurementToggle.setAttribute("aria-expanded", "false");
  measurementCount.hidden = true;
  resetChat();
  problemInput.value = "";
  resizeProblemInput();
  status.textContent = "Sẵn sàng";
  parserNote.textContent = "Đã xóa ngữ cảnh cũ. Hãy nhập đề bài mới.";
  grid.position.y = -1.75;
  updateProblemStatement();
  updateComposerForContext();
  if (focusInput) problemInput.focus();
}

function restoreSavedProblem() {
  if (!loadSession()) return false;
  resetChat();
  updateProblemStatement();
  currentSession.messages.forEach((message) => appendMessage(message.text, message.type, false));
  buildAiGeometry(currentSession.geometry);
  problemInput.value = "";
  resizeProblemInput();
  parserNote.textContent = "Đã khôi phục ngữ cảnh bài đang làm. Bạn có thể yêu cầu xóa hoặc vẽ thêm.";
  updateComposerForContext();
  return true;
}

async function repairRestoredGeometry() {
  if (!currentSession.geometry || !currentSession.originalProblem) return;
  try {
    const response = await fetch("/api/geometry/repair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        original_problem: getProblemWithMeasurements(),
        current_geometry: currentSession.geometry,
        relation_context: [
          currentSession.messages.map((message) => message.text).join("\n"),
          getMeasurementContext(),
        ].filter(Boolean).join("\n").slice(-12_000),
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.geometry) return;
    currentSession.geometry = data.geometry;
    buildAiGeometry(data.geometry);
    saveSession();
    parserNote.textContent = "Đã kiểm tra lại trung điểm, giao điểm, hình chiếu và điểm di động bằng tọa độ.";
  } catch {
    // Giữ nguyên mô hình đã lưu nếu việc kiểm tra cục bộ không hoàn tất.
  }
}

async function submitProblem() {
  const text = problemInput.value.trim();
  if (!text) {
    parserNote.textContent = "Hãy nhập một đề bài để bắt đầu dựng hình.";
    problemInput.focus();
    return;
  }

  problemInput.value = "";
  resizeProblemInput();
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
        original_problem: getProblemWithMeasurements(),
        previous_response_id: currentSession.responseId,
        current_geometry: currentSession.geometry,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Không thể kết nối với trợ lý AI.");

    currentSession.originalProblem ||= text;
    currentSession.geometry = data.geometry;
    currentSession.responseId = data.response_id || null;
    currentSession.updatedAt = new Date().toISOString();
    if (!hasContext) problemExpanded = false;
    updateProblemStatement();
    buildAiGeometry(data.geometry);
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
  if (!text) {
    parserNote.textContent = "Hãy nhập câu hỏi hoặc câu trả lời trước khi gửi.";
    problemInput.focus();
    return;
  }
  const question = text;

  problemInput.value = "";
  resizeProblemInput();
  appendMessage(question, "user");
  setLoading(true, "explain");
  parserNote.textContent = "AI đang xem phần em vừa hỏi…";

  try {
    const looksLikeFullProblem = /hình\s+(?:chóp|hộp|lập phương|lăng trụ)|tứ diện/i.test(question);
    if (!currentSession.geometry && looksLikeFullProblem) {
      parserNote.textContent = "Đang dựng hình nền trước bước gợi mở đầu tiên…";
      const geometryResponse = await fetch("/api/geometry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: question,
          original_problem: "",
          previous_response_id: null,
          current_geometry: null,
        }),
      });
      const geometryData = await geometryResponse.json();
      if (!geometryResponse.ok) {
        throw new Error(geometryData.error || "Không thể dựng hình nền cho câu hỏi.");
      }
      currentSession.originalProblem = question;
      currentSession.geometry = geometryData.geometry;
      currentSession.responseId = geometryData.response_id || null;
      updateProblemStatement();
      buildAiGeometry(geometryData.geometry);
      saveSession();
      parserNote.textContent = "Đang chuẩn bị câu hỏi gợi mở đầu tiên…";
    }

    const response = await fetch("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: question,
        original_problem: getProblemWithMeasurements(),
        current_geometry: currentSession.geometry,
        conversation: currentSession.messages,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Không thể kết nối với trợ lý AI.");
    currentSession.tutorActive = data.student_status !== "completed";
    appendMessage(data.answer, "assistant");
    if (data.geometry_updated && data.geometry) {
      currentSession.geometry = data.geometry;
      buildAiGeometry(data.geometry);
      saveSession();
    }
    const tutorStatus = {
      correct: "Câu trả lời đúng — đã mở bước tiếp theo.",
      partially_correct: "Câu trả lời đúng một phần — hãy bổ sung theo câu hỏi gợi mở.",
      incorrect: "Chưa đúng — hãy thử lại từ gợi ý hiện tại.",
      completed: "Bạn đã tự hoàn thành lời giải.",
      no_attempt: "Đã mở bước suy luận đầu tiên.",
    };
    parserNote.textContent = tutorStatus[data.student_status] || "Đã đưa ra câu hỏi gợi mở tiếp theo.";
    saveSession();
    updateComposerForContext();
  } catch (error) {
    appendMessage(error.message, "assistant");
    parserNote.textContent = "Không thể trả lời lúc này.";
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

function resizeProblemInput() {
  problemInput.style.height = "auto";
  const nextHeight = Math.min(Math.max(problemInput.scrollHeight, 42), 180);
  problemInput.style.height = `${nextHeight}px`;
  problemInput.style.overflowY = problemInput.scrollHeight > 180 ? "auto" : "hidden";
}

function setMathPopover(open) {
  mathPopover.hidden = !open;
  mathToggleButton.setAttribute("aria-expanded", String(open));
}

function insertMathSymbol(symbol) {
  const start = problemInput.selectionStart ?? problemInput.value.length;
  const end = problemInput.selectionEnd ?? start;
  problemInput.setRangeText(symbol, start, end, "end");
  problemInput.focus();
  problemInput.dispatchEvent(new Event("input", { bubbles: true }));
}

function getPastedImage(clipboardData) {
  const imageItem = Array.from(clipboardData?.items || [])
    .find((item) => item.kind === "file" && item.type.startsWith("image/"));
  const pastedFile = imageItem?.getAsFile();
  if (!pastedFile) return null;

  const extensionByType = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const extension = extensionByType[pastedFile.type] || "png";
  return new File(
    [pastedFile],
    "anh-de-bai-" + Date.now() + "." + extension,
    { type: pastedFile.type || "image/png" },
  );
}

drawButton.addEventListener("click", submitProblem);
explainButton.addEventListener("click", explainProblem);
newProblemButton.addEventListener("click", () => startNewProblem());
problemToggle.addEventListener("click", () => {
  problemExpanded = !problemExpanded;
  updateProblemStatement();
});
measurementToggle.addEventListener("click", () => {
  if (!currentSession.geometry) return;
  measurementPanelOpen = !measurementPanelOpen;
  renderMeasurementPanel(currentSession.geometry);
});
measurementClose.addEventListener("click", () => {
  measurementPanelOpen = false;
  if (currentSession.geometry) renderMeasurementPanel(currentSession.geometry);
});
mathSymbolButtons.forEach((button) => {
  button.addEventListener("click", () => {
    insertMathSymbol(button.dataset.symbol || "");
    setMathPopover(false);
  });
});
mathToggleButton.addEventListener("click", (event) => {
  event.stopPropagation();
  setMathPopover(mathPopover.hidden);
});
problemImageInput.addEventListener("change", () => {
  readProblemImage(problemImageInput.files?.[0]);
});
removeImageButton.addEventListener("click", () => clearOcrPreview());
document.addEventListener("paste", (event) => {
  const pastedImage = getPastedImage(event.clipboardData);
  if (!pastedImage) return;
  event.preventDefault();
  readProblemImage(pastedImage);
});
document.addEventListener("click", (event) => {
  if (mathPopover.hidden || mathPopover.contains(event.target)) return;
  setMathPopover(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  setMathPopover(false);
  if (measurementPanelOpen) {
    measurementPanelOpen = false;
    if (currentSession.geometry) renderMeasurementPanel(currentSession.geometry);
  }
});
problemInput.addEventListener("input", resizeProblemInput);
problemInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  explainProblem();
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
resizeProblemInput();
if (!restoreSavedProblem()) {
  resetChat();
  if (defaultProblem.trim()) drawLocally(defaultProblem);
  else {
    clearFigure();
    status.textContent = "Sẵn sàng";
  }
  updateComposerForContext();
} else {
  repairRestoredGeometry();
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
