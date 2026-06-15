import { Graphics } from './graphics';
import type { UpdateContext } from './engine';

// A node in the scene tree. Override update()/draw(); use add()/remove().
export class Node {
  x = 0;
  y = 0;
  visible = true;
  dead = false;
  children: Node[] = [];
  parent: Node | null = null;

  add<T extends Node>(child: T): T {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  /** Mark for removal at the end of this update pass. */
  remove(): void {
    this.dead = true;
  }

  // Override these in subclasses.
  update(_ctx: UpdateContext): void {}
  draw(_g: Graphics): void {}

  updateTree(ctx: UpdateContext): void {
    if (this.dead) return;
    this.update(ctx);
    for (const c of this.children) c.updateTree(ctx);
    let removed = false;
    for (const c of this.children) if (c.dead) removed = true;
    if (removed) this.children = this.children.filter((c) => !c.dead);
  }

  drawTree(g: Graphics): void {
    if (!this.visible || this.dead) return;
    this.draw(g);
    for (const c of this.children) c.drawTree(g);
  }
}

// A top-level scene. The engine manages a stack of these.
export class Scene extends Node {
  onEnter(_ctx: UpdateContext): void {}
  onExit(): void {}
}
