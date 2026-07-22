import { html, LitElement, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import * as THREE from "three";

type OrbPalette = {
	main: [number, number, number];
	inner: [number, number, number];
	outer: [number, number, number];
	ring: number;
	sigil: number;
	node: number;
};

const DARK_PALETTE: OrbPalette = {
	main: [0x82aaff, 0x7fdbca, 0x863bff],
	inner: [0xc792ea, 0x47bfff, 0xf78c6c],
	outer: [0x7fdbca, 0x82aaff, 0xb985e9],
	ring: 0xecc48d,
	sigil: 0xc792ea,
	node: 0xecc48d,
};

const LIGHT_PALETTE: OrbPalette = {
	main: [0x863bff, 0x47bfff, 0xede6ff],
	inner: [0x7e14ff, 0xb985e9, 0xf78c6c],
	outer: [0x47bfff, 0x863bff, 0xede6ff],
	ring: 0x863bff,
	sigil: 0x7e14ff,
	node: 0xf78c6c,
};

function getPalette(isDark: boolean): OrbPalette {
	return isDark ? DARK_PALETTE : LIGHT_PALETTE;
}

@customElement("orb-animation")
export class OrbAnimation extends LitElement {
	private container?: HTMLDivElement;
	private scene?: typeof THREE.Scene;
	private camera?: typeof THREE.PerspectiveCamera;
	private renderer?: typeof THREE.WebGLRenderer;
	private orb?: typeof THREE.Mesh;
	private innerOrb?: typeof THREE.Mesh;
	private outerOrb?: typeof THREE.Mesh;
	private brandRing?: typeof THREE.Mesh;
	private sigilRing?: typeof THREE.Mesh;
	private meridianRing?: typeof THREE.Mesh;
	private anchorNodes: (typeof THREE.Mesh)[] = [];
	private animationFrame?: number;
	private time = 0;
	private currentIsDark = false;

	protected createRenderRoot(): HTMLElement | ShadowRoot {
		return this;
	}

	override firstUpdated() {
		this.container = this.querySelector(".orb-container") as HTMLDivElement;
		if (!this.container) return;

		// Wait for CSS to apply and container to have dimensions
		requestAnimationFrame(() => {
			this.initThreeJS();
			this.animateOrb();
		});
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		if (this.animationFrame) {
			cancelAnimationFrame(this.animationFrame);
		}
		if (this.renderer) {
			this.renderer.dispose();
		}
	}

	private initThreeJS() {
		if (!this.container) return;

		// Get theme from document class (checks for .dark class)
		this.currentIsDark = document.documentElement.classList.contains("dark");
		const palette = getPalette(this.currentIsDark);

		// Scene setup
		this.scene = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(
			75,
			this.container.clientWidth / this.container.clientHeight,
			0.1,
			1000,
		);
		this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });

		this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.setClearColor(0x000000, 0);
		this.container.appendChild(this.renderer.domElement);

		this.camera.position.z = 4.5;

		// Vertex shader with morphing distortion
		const vertexShader = `
			varying vec3 vNormal;
			varying vec3 vPosition;
			varying vec3 vWorldPosition;
			uniform float time;
			uniform float distortStrength;
			uniform float swirlStrength;
			uniform float leadingStrength;
			uniform float trailingStrength;
			uniform float layerSkew;
			uniform float verticalCompress;

			void main() {
				vNormal = normalize(normalMatrix * normal);
				vPosition = position;

				// Intense morphing distortion
				vec3 pos = position;
				float t = time * 0.8;

				// Multiple sine waves creating organic motion
				float distort = sin(pos.x * 2.0 + t) * cos(pos.y * 1.5 + t * 1.3) * 0.15;
				distort += sin(pos.y * 3.0 + t * 1.7) * cos(pos.z * 2.0 + t * 0.9) * 0.12;
				distort += cos(pos.z * 2.5 + t * 1.1) * sin(pos.x * 1.8 + t * 1.5) * 0.1;
				distort *= distortStrength;

				// Swirling motion
				float swirl = sin(length(pos.xy) * 3.0 - t * 2.0) * 0.08 * swirlStrength;

				// Directional bias so the orb feels more like a branded object than a perfect plasma sphere
				vec3 leadingAxis = normalize(vec3(0.85, 0.2, -0.45));
				vec3 trailingAxis = normalize(vec3(-0.65, -0.1, 0.75));
				float leading = pow(max(0.0, dot(normalize(position), leadingAxis)), 2.0);
				float trailing = pow(max(0.0, dot(normalize(position), trailingAxis)), 3.0);
				float seam = exp(-abs(pos.y) * (2.6 + verticalCompress * 1.3));

				pos.x *= 1.0 + layerSkew * 0.08;
				pos.y *= 1.0 - verticalCompress * 0.1;
				pos.z *= 1.0 + (layerSkew - verticalCompress) * 0.04;
				pos += normal * (distort + swirl);
				pos += leadingAxis * leading * 0.16 * leadingStrength * sin(t * 1.4 + pos.y * 2.2);
				pos -= normal * trailing * 0.12 * trailingStrength * (0.55 + 0.45 * sin(t * 1.1));
				pos += leadingAxis * seam * layerSkew * 0.06 * sin(t * 1.2 + pos.z * 3.2);

				vec4 worldPos = modelMatrix * vec4(pos, 1.0);
				vWorldPosition = worldPos.xyz;

				gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
			}
		`;

		const fragmentShader = `
			varying vec3 vNormal;
			varying vec3 vPosition;
			varying vec3 vWorldPosition;
			uniform float time;
			uniform vec3 color1;
			uniform vec3 color2;
			uniform vec3 color3;
			uniform float plasmaScale;
			uniform float bandScale;
			uniform float glowIntensity;
			uniform float baseOpacity;
			uniform float edgePower;
			uniform float centerBias;
			uniform float verticalCompress;

			void main() {
				vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
				float fresnel = pow(1.0 - abs(dot(viewDirection, vNormal)), 3.0);
				vec2 warped = vec2(
					vPosition.x * (1.0 + abs(verticalCompress) * 0.22),
					vPosition.y * (1.0 - verticalCompress * 0.35)
				);

				// Plasma-like color mixing
				float t = time * 0.5;
				float plasma = sin(warped.x * plasmaScale + t) +
							  sin(warped.y * (plasmaScale * 0.72) + t * 1.3) +
							  sin((warped.x + warped.y) * (plasmaScale * 0.45) + t * 0.7) +
							  cos(length(warped.xy) * (plasmaScale * 1.2) - t * 2.0);
				plasma = plasma * 0.25 + 0.5;

				// Swirling color bands
				float bands = sin(length(warped.xy) * bandScale - t * 3.0 + plasma * 2.0) * 0.5 + 0.5;
				float core = 1.0 - smoothstep(0.35, 1.75, length(warped));

				vec3 color = mix(color1, color2, plasma);
				color = mix(color, color3, bands * 0.72 + core * 0.28);
				color = mix(color, mix(color1, color2, 0.35), core * centerBias);

				// Lower opacity to prevent white washout, but keep it visible
				float pulse = sin(t * 2.0) * 0.08 + 0.92;
				float edge = pow(fresnel, edgePower) * glowIntensity;
				float opacity = clamp((baseOpacity + edge + core * centerBias * 0.35) * pulse, 0.0, 0.95);

				// Darken the colors for better visibility on light backgrounds
				vec3 finalColor = color * (0.42 + edge * 1.35) + color2 * core * centerBias * 0.18;

				gl_FragColor = vec4(finalColor, opacity);
			}
		`;

		// Create main orb with theme-aware colors
		const orbGeometry = new THREE.SphereGeometry(1.26, 144, 144);
		const orbMaterial = new THREE.ShaderMaterial({
			vertexShader: vertexShader,
			fragmentShader: fragmentShader,
			uniforms: {
				time: { value: 0 },
				color1: { value: new THREE.Color(palette.main[0]) },
				color2: { value: new THREE.Color(palette.main[1]) },
				color3: { value: new THREE.Color(palette.main[2]) },
				distortStrength: { value: 0.92 },
				swirlStrength: { value: 0.68 },
				leadingStrength: { value: 1.08 },
				trailingStrength: { value: 0.88 },
				layerSkew: { value: 1.12 },
				verticalCompress: { value: 0.42 },
				plasmaScale: { value: 2.9 },
				bandScale: { value: 5.4 },
				glowIntensity: { value: 0.4 },
				baseOpacity: { value: 0.1 },
				edgePower: { value: 1.25 },
				centerBias: { value: 1.08 },
			},
			transparent: true,
			blending: THREE.AdditiveBlending,
			side: THREE.DoubleSide,
			depthWrite: false,
		});

		this.orb = new THREE.Mesh(orbGeometry, orbMaterial);
		this.orb.position.set(0.05, 0.01, 0.06);
		this.orb.scale.set(1.02, 0.84, 1.12);
		this.scene.add(this.orb);

		// Replace the middle base layer with a torus so the orb stops reading like three related spheres.
		const innerGeometry = new THREE.TorusGeometry(0.68, 0.22, 36, 180);
		const innerMaterial = new THREE.ShaderMaterial({
			vertexShader: vertexShader,
			fragmentShader: fragmentShader,
			uniforms: {
				time: { value: 0 },
				color1: { value: new THREE.Color(palette.inner[0]) },
				color2: { value: new THREE.Color(palette.inner[1]) },
				color3: { value: new THREE.Color(palette.inner[2]) },
				distortStrength: { value: 0.34 },
				swirlStrength: { value: 0.08 },
				leadingStrength: { value: 0.42 },
				trailingStrength: { value: 0.12 },
				layerSkew: { value: 1.9 },
				verticalCompress: { value: 1.55 },
				plasmaScale: { value: 1.5 },
				bandScale: { value: 16.0 },
				glowIntensity: { value: 0.18 },
				baseOpacity: { value: 0.07 },
				edgePower: { value: 2.2 },
				centerBias: { value: 1.35 },
			},
			transparent: true,
			blending: THREE.AdditiveBlending,
			side: THREE.DoubleSide,
			depthWrite: false,
		});

		this.innerOrb = new THREE.Mesh(innerGeometry, innerMaterial);
		this.innerOrb.position.set(0.02, 0.01, 0.24);
		this.innerOrb.scale.set(1.18, 0.76, 0.56);
		this.scene.add(this.innerOrb);

		// Turn the outer base layer into a partial torus crescent so it stops reading like a shell around the core.
		const outerGeometry = new THREE.TorusGeometry(1.02, 0.26, 28, 180, Math.PI * 1.38);
		const outerMaterial = new THREE.ShaderMaterial({
			vertexShader: vertexShader,
			fragmentShader: fragmentShader,
			uniforms: {
				time: { value: 0 },
				color1: { value: new THREE.Color(palette.outer[0]) },
				color2: { value: new THREE.Color(palette.outer[1]) },
				color3: { value: new THREE.Color(palette.outer[2]) },
				distortStrength: { value: 1.18 },
				swirlStrength: { value: 1.36 },
				leadingStrength: { value: 0.22 },
				trailingStrength: { value: 0.08 },
				layerSkew: { value: 0.52 },
				verticalCompress: { value: 0.24 },
				plasmaScale: { value: 5.2 },
				bandScale: { value: 4.0 },
				glowIntensity: { value: 0.42 },
				baseOpacity: { value: 0.03 },
				edgePower: { value: 0.82 },
				centerBias: { value: 0.18 },
			},
			transparent: true,
			blending: THREE.AdditiveBlending,
			side: THREE.DoubleSide,
			depthWrite: false,
		});

		this.outerOrb = new THREE.Mesh(outerGeometry, outerMaterial);
		this.outerOrb.position.set(0.18, -0.04, -0.14);
		this.outerOrb.rotation.set(Math.PI * 0.18, -Math.PI * 0.12, Math.PI * 0.34);
		this.outerOrb.scale.set(1.02, 0.84, 0.92);
		this.scene.add(this.outerOrb);

		// Add a tilted branded ring so the orb reads less like a generic plasma sphere.
		const ringGeometry = new THREE.TorusGeometry(1.64, 0.034, 20, 180);
		const ringMaterial = new THREE.MeshBasicMaterial({
			color: new THREE.Color(palette.ring),
			transparent: true,
			opacity: this.currentIsDark ? 0.42 : 0.3,
			blending: THREE.AdditiveBlending,
			side: THREE.DoubleSide,
			depthWrite: false,
		});

		this.brandRing = new THREE.Mesh(ringGeometry, ringMaterial);
		this.brandRing.rotation.x = Math.PI * 0.68;
		this.brandRing.rotation.z = Math.PI * 0.16;
		this.brandRing.position.set(0.06, -0.03, 0);
		this.brandRing.scale.set(1.02, 0.84, 1);
		this.scene.add(this.brandRing);

		// Add an inner sigil so the orb reads more like a branded artifact than a raw effect.
		const sigilGeometry = new THREE.TorusGeometry(1.02, 0.018, 18, 180);
		const sigilMaterial = new THREE.MeshBasicMaterial({
			color: new THREE.Color(palette.sigil),
			transparent: true,
			opacity: this.currentIsDark ? 0.34 : 0.24,
			blending: THREE.AdditiveBlending,
			side: THREE.DoubleSide,
			depthWrite: false,
		});

		this.sigilRing = new THREE.Mesh(sigilGeometry, sigilMaterial);
		this.sigilRing.rotation.x = Math.PI * 0.52;
		this.sigilRing.rotation.z = -Math.PI * 0.22;
		this.sigilRing.scale.set(1.08, 0.54, 1);
		this.scene.add(this.sigilRing);

		const meridianGeometry = new THREE.TorusGeometry(0.74, 0.012, 14, 120);
		const meridianMaterial = new THREE.MeshBasicMaterial({
			color: new THREE.Color(palette.node),
			transparent: true,
			opacity: this.currentIsDark ? 0.26 : 0.18,
			blending: THREE.AdditiveBlending,
			side: THREE.DoubleSide,
			depthWrite: false,
		});

		this.meridianRing = new THREE.Mesh(meridianGeometry, meridianMaterial);
		this.meridianRing.rotation.y = Math.PI * 0.24;
		this.meridianRing.rotation.z = Math.PI * 0.5;
		this.meridianRing.scale.set(1, 1.06, 1);
		this.scene.add(this.meridianRing);

		const nodeGeometry = new THREE.SphereGeometry(0.048, 24, 24);
		this.anchorNodes = [];
		for (let i = 0; i < 4; i += 1) {
			const nodeMaterial = new THREE.MeshBasicMaterial({
				color: new THREE.Color(palette.node),
				transparent: true,
				opacity: this.currentIsDark ? 0.75 : 0.55,
				blending: THREE.AdditiveBlending,
				side: THREE.DoubleSide,
				depthWrite: false,
			});
			const node = new THREE.Mesh(nodeGeometry, nodeMaterial);
			this.anchorNodes.push(node);
			this.scene.add(node);
		}
	}

	private updateTheme(isDark: boolean) {
		if (
			!this.orb ||
			!this.innerOrb ||
			!this.outerOrb ||
			!this.brandRing ||
			!this.sigilRing ||
			!this.meridianRing ||
			this.anchorNodes.length === 0
		) {
			return;
		}

		const palette = getPalette(isDark);

		// Update main orb colors
		const orbMaterial = this.orb.material as typeof THREE.ShaderMaterial;
		orbMaterial.uniforms.color1.value = new THREE.Color(palette.main[0]);
		orbMaterial.uniforms.color2.value = new THREE.Color(palette.main[1]);
		orbMaterial.uniforms.color3.value = new THREE.Color(palette.main[2]);

		// Update inner orb colors
		const innerMaterial = this.innerOrb.material as typeof THREE.ShaderMaterial;
		innerMaterial.uniforms.color1.value = new THREE.Color(palette.inner[0]);
		innerMaterial.uniforms.color2.value = new THREE.Color(palette.inner[1]);
		innerMaterial.uniforms.color3.value = new THREE.Color(palette.inner[2]);

		// Update outer orb colors
		const outerMaterial = this.outerOrb.material as typeof THREE.ShaderMaterial;
		outerMaterial.uniforms.color1.value = new THREE.Color(palette.outer[0]);
		outerMaterial.uniforms.color2.value = new THREE.Color(palette.outer[1]);
		outerMaterial.uniforms.color3.value = new THREE.Color(palette.outer[2]);

		const ringMaterial = this.brandRing.material as typeof THREE.MeshBasicMaterial;
		ringMaterial.color = new THREE.Color(palette.ring);
		ringMaterial.opacity = isDark ? 0.42 : 0.3;

		const sigilMaterial = this.sigilRing.material as typeof THREE.MeshBasicMaterial;
		sigilMaterial.color = new THREE.Color(palette.sigil);
		sigilMaterial.opacity = isDark ? 0.34 : 0.24;

		const meridianMaterial = this.meridianRing.material as typeof THREE.MeshBasicMaterial;
		meridianMaterial.color = new THREE.Color(palette.node);
		meridianMaterial.opacity = isDark ? 0.26 : 0.18;

		for (const node of this.anchorNodes) {
			const nodeMaterial = node.material as typeof THREE.MeshBasicMaterial;
			nodeMaterial.color = new THREE.Color(palette.node);
			nodeMaterial.opacity = isDark ? 0.75 : 0.55;
		}
	}

	private animateOrb = () => {
		if (
			!this.scene ||
			!this.camera ||
			!this.renderer ||
			!this.orb ||
			!this.innerOrb ||
			!this.outerOrb ||
			!this.brandRing ||
			!this.sigilRing ||
			!this.meridianRing ||
			this.anchorNodes.length === 0
		) {
			return;
		}

		// Check if theme has changed
		const isDark = document.documentElement.classList.contains("dark");
		if (isDark !== this.currentIsDark) {
			this.currentIsDark = isDark;
			this.updateTheme(isDark);
		}

		this.time += 0.01;

		// Update shader uniforms with different time speeds
		(this.orb.material as typeof THREE.ShaderMaterial).uniforms.time.value = this.time;
		(this.innerOrb.material as typeof THREE.ShaderMaterial).uniforms.time.value = this.time * 1.5;
		(this.outerOrb.material as typeof THREE.ShaderMaterial).uniforms.time.value = this.time * 0.7;

		// Differentiate the original layers so they read as a core, iris, and haze rather than three copies.
		this.orb.rotation.y = this.time * 0.22;
		this.orb.rotation.x = Math.sin(this.time * 0.42) * 0.26;
		this.orb.rotation.z = Math.cos(this.time * 0.28) * 0.18;
		this.orb.position.x = 0.05 + Math.sin(this.time * 0.22) * 0.05;
		this.orb.position.y = 0.01 + Math.cos(this.time * 0.31) * 0.03;
		this.orb.position.z = 0.06 + Math.sin(this.time * 0.27) * 0.04;

		this.innerOrb.rotation.y = -this.time * 0.34;
		this.innerOrb.rotation.x = Math.PI * 0.16 + Math.cos(this.time * 0.46) * 0.12;
		this.innerOrb.rotation.z = Math.PI * 0.06 + Math.sin(this.time * 0.34) * 0.18;
		this.innerOrb.position.x = 0.02 + Math.cos(this.time * 0.32) * 0.04;
		this.innerOrb.position.y = 0.01 + Math.sin(this.time * 0.44) * 0.025;
		this.innerOrb.position.z = 0.24 + Math.cos(this.time * 0.38) * 0.04;

		this.outerOrb.rotation.y = -Math.PI * 0.12 + this.time * 0.1;
		this.outerOrb.rotation.x = Math.PI * 0.18 + Math.sin(this.time * 0.2) * 0.12;
		this.outerOrb.rotation.z = Math.PI * 0.34 - Math.cos(this.time * 0.24) * 0.14;
		this.outerOrb.position.x = 0.18 + Math.sin(this.time * 0.16) * 0.05;
		this.outerOrb.position.y = -0.04 + Math.cos(this.time * 0.21) * 0.04;
		this.outerOrb.position.z = -0.14 + Math.sin(this.time * 0.19) * 0.03;

		// Keep the ring in a different rhythm so it feels like a deliberate accent, not part of the same blob.
		this.brandRing.rotation.y = this.time * 0.45;
		this.brandRing.rotation.x = Math.PI * 0.68 + Math.sin(this.time * 0.4) * 0.06;
		this.brandRing.rotation.z = Math.PI * 0.16 + Math.cos(this.time * 0.3) * 0.08;
		this.brandRing.position.x = 0.06 + Math.sin(this.time * 0.55) * 0.05;
		this.brandRing.position.y = -0.03 + Math.cos(this.time * 0.4) * 0.04;

		this.sigilRing.rotation.y = -this.time * 0.28;
		this.sigilRing.rotation.x = Math.PI * 0.52 + Math.sin(this.time * 0.45) * 0.05;
		this.sigilRing.rotation.z = -Math.PI * 0.22 + Math.cos(this.time * 0.32) * 0.07;

		this.meridianRing.rotation.x = Math.sin(this.time * 0.33) * 0.18;
		this.meridianRing.rotation.y = Math.PI * 0.24 - this.time * 0.38;
		this.meridianRing.rotation.z = Math.PI * 0.5 + Math.cos(this.time * 0.48) * 0.08;

		// Pulsing scale for breathing effect
		const corePulse = 1.0 + Math.sin(this.time * 0.78) * 0.035;
		this.orb.scale.set(
			1.02 * corePulse,
			0.84 + Math.cos(this.time * 0.64) * 0.03,
			1.12 + Math.sin(this.time * 0.52) * 0.04,
		);

		const irisPulse = 1.0 + Math.cos(this.time * 1.15) * 0.03;
		this.innerOrb.scale.set(
			1.18 + Math.sin(this.time * 0.72) * 0.035,
			0.76 * irisPulse,
			0.56 + Math.cos(this.time * 0.84) * 0.025,
		);

		const hazePulse = 1.0 + Math.sin(this.time * 0.55) * 0.05;
		this.outerOrb.scale.set(
			1.02 * hazePulse,
			0.84 + Math.cos(this.time * 0.44) * 0.035,
			0.92 + Math.sin(this.time * 0.33) * 0.04,
		);

		const ringPulse = 1.0 + Math.sin(this.time * 0.9) * 0.03;
		this.brandRing.scale.set(1.02 * ringPulse, 0.84 * ringPulse, ringPulse);

		const sigilPulse = 1.0 + Math.cos(this.time * 1.2) * 0.025;
		this.sigilRing.scale.set(1.08 * sigilPulse, 0.54 * sigilPulse, sigilPulse);

		const meridianPulse = 1.0 + Math.sin(this.time * 1.05 + 0.8) * 0.035;
		this.meridianRing.scale.set(meridianPulse, 1.06 * meridianPulse, meridianPulse);

		const nodeRadiusX = 0.94;
		const nodeRadiusY = 0.58;
		this.anchorNodes.forEach((node, index) => {
			const angle = this.time * 0.42 + index * (Math.PI * 0.5);
			const radialPulse = 1 + Math.sin(this.time * 0.9 + index) * 0.06;
			const nodeScale = 0.92 + Math.sin(this.time * 1.4 + index * 1.2) * 0.14;
			node.position.set(
				Math.cos(angle) * nodeRadiusX * radialPulse,
				Math.sin(angle) * nodeRadiusY * 0.72 * radialPulse,
				Math.cos(angle * 1.5 + this.time * 0.35) * 0.18,
			);
			node.scale.set(nodeScale, nodeScale, nodeScale);
		});

		this.renderer.render(this.scene, this.camera);

		this.animationFrame = requestAnimationFrame(this.animateOrb);
	};

	override render(): TemplateResult {
		return html`<div class="orb-container"></div>`;
	}
}
