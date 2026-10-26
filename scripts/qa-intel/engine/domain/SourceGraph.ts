export interface GraphNode {
  path: string;
  imports: string[];
}

export class SourceGraph {
  private nodes = new Map<string, GraphNode>();

  add(node: GraphNode) {
    this.nodes.set(node.path, node);
  }

  get(path: string) {
    return this.nodes.get(path);
  }

  all() {
    return Array.from(this.nodes.values());
  }
}
