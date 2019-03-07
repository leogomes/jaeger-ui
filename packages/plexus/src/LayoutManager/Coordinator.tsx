// Copyright (c) 2017 Uber Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/* eslint-disable no-console */

import * as convCoord from './dot/conv-coord';
import { matchEdges, matchVertices } from './match-inputs';
// eslint-disable-next-line import/order, import/no-unresolved
import LayoutWorker from 'worker-alias/LayoutManager/layout.worker';

import {
  ECoordinatorPhase,
  EWorkerErrorType,
  EWorkerPhase,
  TLayoutOptions,
  TUpdate,
  TWorkerErrorMessage,
  TWorkerOutputMessage,
} from './types';
import { TEdge, TLayoutEdge, TLayoutVertex, TSizeVertex } from '../types';

type TCurrentLayout = {
  cleaned: {
    edges: TEdge[];
    vertices: TSizeVertex[];
  };
  id: number;
  input: {
    edges: TEdge[];
    vertices: TSizeVertex[];
  };
  options: TLayoutOptions | void;
  status: {
    workerId?: number | null;
    phase: ECoordinatorPhase;
  };
};

function cleanInput(
  srcEdges: TEdge[],
  srcVertices: TSizeVertex[]
): { edges: TEdge[]; vertices: TSizeVertex[] } {
  const edges = srcEdges.map(({ from, to, isBidirectional }) => ({ from, to, isBidirectional }));
  const vertices = srcVertices.map(({ vertex: { key }, ...rest }) => ({ vertex: { key }, ...rest }));
  return { edges, vertices };
}

function killWorker(worker: LayoutWorker) {
  const w = worker;
  // to make flow happy
  const noop = () => {};
  w.onmessage = noop;
  // $FlowFixMe - https://github.com/facebook/flow/issues/6191
  w.onmessageerror = noop;
  w.onerror = noop;
  w.terminate();
}

function findAndRemoveWorker(lists: LayoutWorker[][], worker: LayoutWorker) {
  for (let i = 0; i < lists.length; i++) {
    const list = lists[i];
    const wi = list.indexOf(worker);
    if (wi >= 0) {
      list.splice(wi, 1);
      return { ok: true, list };
    }
  }
  return { ok: false };
}

export default class Coordinator {
  currentLayout: TCurrentLayout | null;
  nextWorkerId: number;
  idleWorkers: LayoutWorker[];
  busyWorkers: LayoutWorker[];
  callback: (update: TUpdate) => void;

  constructor(callback: (update: TUpdate) => void) {
    this.callback = callback;
    this.currentLayout = null;
    this.nextWorkerId = 0;
    this.idleWorkers = [];
    this.busyWorkers = [];
  }

  getLayout(id: number, edges: TEdge[], vertices: TSizeVertex[], options: TLayoutOptions | void) {
    this.busyWorkers.forEach(killWorker);
    this.busyWorkers.length = 0;
    const cleaned = cleanInput(edges, vertices.map(convCoord.vertexToDot));
    this.currentLayout = {
      cleaned,
      id,
      options,
      input: { edges, vertices },
      status: { phase: ECoordinatorPhase.NotStarted },
    };
    const isDotOnly = Boolean(options && options.useDotEdges);
    const phase = isDotOnly ? EWorkerPhase.DotOnly : EWorkerPhase.Positions;
    this._postWork(phase, cleaned.edges, cleaned.vertices);
  }

  stopAndRelease() {
    this.idleWorkers.forEach(killWorker);
    this.idleWorkers.length = 0;
    this.busyWorkers.forEach(killWorker);
    this.busyWorkers.length = 0;
    this.currentLayout = null;
  }

  _initWorker() {
    const worker = new LayoutWorker();
    worker.id = this.nextWorkerId;
    this.nextWorkerId++;
    worker.onerror = this._handleVizWorkerError;
    worker.onmessageerror = this._handleVizWorkerMessageError;
    worker.onmessage = this._handleVizWorkerMessage;
    return worker;
  }

  _makeWorkerIdle(worker: LayoutWorker) {
    const { ok } = findAndRemoveWorker([this.busyWorkers, this.idleWorkers], worker);
    if (ok) {
      this.idleWorkers.push(worker);
    } else {
      killWorker(worker);
    }
  }

  _postWork(phase: EWorkerPhase, edges: TEdge[], vertices: TSizeVertex[] | TLayoutVertex[]) {
    if (!this.currentLayout) {
      throw new Error('_startWork called without a current layout');
    }
    const { id, options, status } = this.currentLayout;
    const worker = this.idleWorkers.pop() || this._initWorker();
    this.busyWorkers.push(worker);
    status.phase = phase as any;
    status.workerId = worker.id;
    worker.postMessage({
      options,
      edges,
      vertices,
      meta: {
        phase,
        layoutId: id,
        workerId: worker.id,
      },
    });
  }

  _handleVizWorkerError = (event: ErrorEvent) => {
    const worker = event.target as LayoutWorker;
    const { ok } = findAndRemoveWorker([this.busyWorkers, this.idleWorkers], worker);
    if (ok) {
      console.error('Viz worker onerror');
      console.error(event);
      killWorker(worker);
    } else {
      console.error('Viz worker onerror from unknown viz worker');
      console.error(event);
    }
  };

  _handleVizWorkerMessageError = (event: ErrorEvent) => {
    // TODO(joe): something more useful
    const msg = {
      event,
      currentLayout: this.currentLayout,
      errorType: '_handleVizWorkerMessageError',
    };
    console.error(msg);
  };

  _handleVizWorkerMessage = (event: MessageEvent) => {
    const worker: LayoutWorker = event.target as LayoutWorker;
    const workerMessage = event.data as TWorkerOutputMessage | TWorkerErrorMessage;
    const { type } = workerMessage;
    this._makeWorkerIdle(worker);
    const isStale =
      !this.currentLayout ||
      Boolean(workerMessage.meta && workerMessage.meta.layoutId !== this.currentLayout.id);
    if (type === EWorkerErrorType.Error) {
      console.error(`${isStale ? '(stale) ' : ''}Error from viz.worker`, event);
      return;
    }
    if (isStale) {
      return;
    }
    if (type === EWorkerErrorType.LayoutError) {
      // TODO(joe): implement retries with more spacing
      console.error('layout-error', event);
      return;
    }
    if (
      workerMessage.type === EWorkerPhase.Positions ||
      workerMessage.type === EWorkerPhase.Edges ||
      workerMessage.type === EWorkerPhase.DotOnly
    ) {
      this._processResult(type, workerMessage);
      return;
    }
    console.error(`Unknown worker message type: ${type}`, event);
  };

  _processResult(phase: EWorkerPhase, workerMessage: TWorkerOutputMessage) {
    const layout = this.currentLayout;
    if (!layout) {
      // make flow happy - this is already checked and should not happen
      return;
    }
    const { edges, graph, meta, vertices } = workerMessage;
    const { workerId } = meta;
    const { cleaned, input, status } = layout;
    const { phase: stPhase, workerId: stWorkerId } = status;

    if ((phase as any) !== stPhase || workerId !== stWorkerId) {
      console.error(`Have work results, but in an invalid state`);
      return;
    }
    if (!vertices || !graph || (phase !== EWorkerPhase.Positions && !edges)) {
      console.error('Have work results, but recieved invalid result data');
      return;
    }

    const adjVertexCoords = convCoord.vertexToPixels.bind(null, graph);
    let adjVertices = vertices.map<TLayoutVertex>(adjVertexCoords);
    adjVertices = matchVertices(input.vertices, adjVertices);
    const adjGraph = convCoord.graphToPixels(graph);

    if (phase === EWorkerPhase.Positions || phase === EWorkerPhase.DotOnly) {
      this.callback({
        type: ECoordinatorPhase.Positions,
        layoutId: layout.id,
        graph: adjGraph,
        vertices: adjVertices,
      });
    }
    // phase is either edges or dot-only
    if (edges) {
      const adjEdgeCoords = convCoord.edgeToPixels.bind(null, graph);
      let adjEdges = edges.map<TLayoutEdge>(adjEdgeCoords);
      adjEdges = matchEdges(input.edges, adjEdges);
      this.callback({
        type: ECoordinatorPhase.Done,
        layoutId: layout.id,
        graph: adjGraph,
        edges: adjEdges,
        vertices: adjVertices,
      });
    }
    if (phase === EWorkerPhase.Positions) {
      this._postWork(EWorkerPhase.Edges, cleaned.edges, vertices);
    }
  }
}
