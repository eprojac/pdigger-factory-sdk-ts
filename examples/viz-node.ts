/**
 * The viz helpers without a browser: SceneView builds its three.js scene graph in Node too (no WebGL needed), here
 * following a unit's Interpreter with a sink of your own next to it. Install `three` beside the SDK.
 *
 *     PDIGGER_FACTORY_URL=http://factory-orin.local:8120 node examples/viz-node.ts
 */
// #region headless
import { FactoryClient, type Update } from "pdigger-factory-sdk";
import { SceneView, attachToClient } from "pdigger-factory-sdk/viz";

const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120");
const scene = new SceneView();
const log = { update: (u: Update) => u.activities.forEach((a) => console.log(a.describe())) }; // any { update(u) }

const following = attachToClient([scene, log], factory, {
  onUpdate: () => {
    if (following.count === 250) following.stop(); // 250 frames, 50 s of media
  },
});
await following.done;
console.log(`${scene.stoneCount} stones in the scene graph after ${following.count} frames`);
scene.dispose();
// #endregion headless
