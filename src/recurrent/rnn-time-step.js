import Matrix from './matrix';
import RandomMatrix from './matrix/random-matrix';
import Equation from './matrix/equation';
import sampleI from './matrix/sample-i';
import maxI from './matrix/max-i';
import softmax from './matrix/softmax';
import copy from './matrix/copy';
import { randomF } from '../utilities/random';
import zeros from '../utilities/zeros';
import DataFormatter from '../utilities/data-formatter';

export default class RNNTimeStep {
  constructor(options = {}) {
    const defaults = RNNTimeStep.defaults;

    for (let p in defaults) {
      if (!defaults.hasOwnProperty(p)) continue;
      this[p] = options.hasOwnProperty(p) ? options[p] : defaults[p];
    }

    this.stepCache = {};
    this.runs = 0;
    this.totalCost = null;
    this.ratioClipped = null;
    this.model = null;

    this.initialLayerInputs = this.hiddenSizes.map((size) => new Matrix(this.hiddenSizes[0], 1));
    this.inputLookup = null;
    this.outputLookup = null;
    this.initialize();
  }

  initialize() {
    this.model = {
      input: null,
      hiddenLayers: [],
      output: null,
      equations: [],
      allMatrices: [],
      equationConnections: []
    };

    if (this.json) {
      this.fromJSON(this.json);
    } else {
      this.mapModel();
    }
  }

  createHiddenLayers() {
    let hiddenSizes = this.hiddenSizes;
    let model = this.model;
    let hiddenLayers = model.hiddenLayers;
    //0 is end, so add 1 to offset
    hiddenLayers.push(this.getModel(hiddenSizes[0], this.inputSize));
    let prevSize = hiddenSizes[0];

    for (let d = 1; d < hiddenSizes.length; d++) { // loop over depths
      let hiddenSize = hiddenSizes[d];
      hiddenLayers.push(this.getModel(hiddenSize, prevSize));
      prevSize = hiddenSize;
    }
  }

  /**
   *
   * @param {Number} hiddenSize
   * @param {Number} prevSize
   * @returns {object}
   */
  getModel(hiddenSize, prevSize) {
    return {
      //wxh
      weight: new RandomMatrix(hiddenSize, prevSize, 0.08),
      //whh
      transition: new RandomMatrix(hiddenSize, hiddenSize, 0.08),
      //bhh
      bias: new Matrix(hiddenSize, 1)
    };
  }

  /**
   *
   * @param {Equation} equation
   * @param {Matrix} inputMatrix
   * @param {Matrix} previousResult
   * @param {Object} hiddenLayer
   * @returns {Matrix}
   */
  getEquation(equation, inputMatrix, previousResult, hiddenLayer) {
    let relu = equation.sigmoid.bind(equation);
    let add = equation.add.bind(equation);
    let multiply = equation.multiply.bind(equation);

    return relu(
      add(
        add(
          multiply(
            hiddenLayer.weight,
            inputMatrix
          ),
          multiply(
            hiddenLayer.transition,
            previousResult
          )
        ),
        hiddenLayer.bias
      )
    );
  }

  createInputMatrix() {
    //0 is end, so add 1 to offset
    this.model.input = new RandomMatrix(1, this.inputSize, 0.08);
  }

  createOutputMatrix() {
    let model = this.model;
    let outputSize = this.outputSize;
    let lastHiddenSize = this.hiddenSizes[this.hiddenSizes.length - 1];

    //whd
    model.outputConnector = new RandomMatrix(outputSize, lastHiddenSize, 0.08);
    //bd
    model.output = new Matrix(outputSize, 1);
  }

  bindEquation() {
    let model = this.model;
    let hiddenSizes = this.hiddenSizes;
    let hiddenLayers = model.hiddenLayers;
    let equation = new Equation();
    let outputs = [];
    let equationConnection = model.equationConnections.length > 0
      ? model.equationConnections[model.equationConnections.length - 1]
      : this.initialLayerInputs
      ;

      // 0 index
    let output = this.getEquation(equation, equation.input(model.input), equationConnection[0], hiddenLayers[0]);
    outputs.push(output);
    // 1+ indices
    for (let i = 1, max = hiddenSizes.length; i < max; i++) {
      output = this.getEquation(equation, output, equationConnection[i], hiddenLayers[i]);
      outputs.push(output);
    }

    model.equationConnections.push(outputs);
    equation.add(equation.multiply(model.outputConnector, output), model.output);
    model.equations.push(equation);
  }

  mapModel() {
    let model = this.model;
    let hiddenLayers = model.hiddenLayers;
    let allMatrices = model.allMatrices;

    this.createInputMatrix();
    if (!model.input) throw new Error('net.model.input not set');
    allMatrices.push(model.input);

    this.createHiddenLayers();
    if (!model.hiddenLayers.length) throw new Error('net.hiddenLayers not set');
    for (let i = 0, max = hiddenLayers.length; i < max; i++) {
      let hiddenMatrix = hiddenLayers[i];
      for (let property in hiddenMatrix) {
        if (!hiddenMatrix.hasOwnProperty(property)) continue;
        allMatrices.push(hiddenMatrix[property]);
      }
    }

    this.createOutputMatrix();
    if (!model.outputConnector) throw new Error('net.model.outputConnector not set');
    if (!model.output) throw new Error('net.model.output not set');

    allMatrices.push(model.outputConnector);
    allMatrices.push(model.output);
  }

  /**
   *
   * @param {Number[]} input
   * @param {Number} [learningRate]
   * @returns {number}
   */
  trainPattern(input, learningRate = null) {
    const error = this.runInput(input);
    this.runBackpropagate(input);
    this.step(learningRate);
    return error;
  }

  /**
   *
   * @param {Number[]} input
   * @returns {number}
   */
  runInput(input) {
    this.runs++;
    let model = this.model;
    let errorSum = 0;
    let equation;
    while (model.equations.length < input.length - 1) {
      this.bindEquation();
    }
    const outputs = [];
    for (let inputIndex = 0, max = input.length - 1; inputIndex < max; inputIndex++) {
      // start and end tokens are zeros
      equation = model.equations[inputIndex];

      const current = input[inputIndex];
      const next = input[inputIndex + 1];
      const output = equation.runInput(current);
      const error = output.weights[0] - next;

      // set gradients into log probabilities
      errorSum += Math.abs(error);

      // write gradients into log probabilities
      output.deltas[0] = error;
      outputs.push(output.weights[0]);
    }

    //this.model.equations.length - 1;
    this.totalCost = errorSum;
    return errorSum;
  }

  runBackpropagate() {
    for (let i = this.model.equations.length - 1; i > -1; i--) {
      this.model.equations[i].runBackpropagate();
    }
  }

  /**
   *
   * @param {Number} [learningRate]
   */
  step(learningRate = null) {
    // perform parameter update
    //TODO: still not sure if this is ready for learningRate
    let stepSize = this.learningRate;
    let regc = this.regc;
    let clipval = this.clipval;
    let model = this.model;
    let numClipped = 0;
    let numTot = 0;
    let allMatrices = model.allMatrices;
    for (let matrixIndex = 0; matrixIndex < allMatrices.length; matrixIndex++) {
      const matrix = allMatrices[matrixIndex];
      const { weights, deltas }  = matrix;
      if (!(matrixIndex in this.stepCache)) {
        this.stepCache[matrixIndex] = zeros(matrix.rows * matrix.columns);
      }
      const cache = this.stepCache[matrixIndex];
      for (let i = 0; i < weights.length; i++) {
        let r = deltas[i];
        let w = weights[i];
        // rmsprop adaptive learning rate
        cache[i] = cache[i] * this.decayRate + (1 - this.decayRate) * r * r;
        // gradient clip
        if (r > clipval) {
          r = clipval;
          numClipped++;
        }
        if (r < -clipval) {
          r = -clipval;
          numClipped++;
        }
        numTot++;
        // update (and regularize)
        weights[i] = w + -stepSize * r / Math.sqrt(cache[i] + this.smoothEps) - regc * w;
      }
    }
    this.ratioClipped = numClipped / numTot;
  }


  /**
   *
   * @returns boolean
   */
  get isRunnable(){
    if(this.model.equations.length === 0){
      console.error(`No equations bound, did you run train()?`);
      return false;
    }

    return true;
  }


  /**
   *
   * @param {Number[]|*} [rawInput]
   * @param {Number} [maxPredictionLength]
   * @param {Boolean} [isSampleI]
   * @param {Number} temperature
   * @returns {*}
   */
  run(input = [], maxPredictionLength = 1, isSampleI = false, temperature = 1) {
    if (!this.isRunnable) return null;
    const model = this.model;
    while (model.equations.length < maxPredictionLength) {
      this.bindEquation();
    }
    let lastOutput;
    for (let i = 0; i < input.length; i++) {
      let outputMatrix = model.equations[i].runInput(input[i]);
      let logProbabilities = new Matrix(model.output.rows, model.output.columns);
      copy(logProbabilities, outputMatrix);
      lastOutput = logProbabilities.weights[0];
    }

    /**
     * we slice the input length here, not because output contains it, but it will be erroneous as we are sending the
     * network what is contained in input, so the data is essentially guessed by the network what could be next, till it
     * locks in on a value.
     * Kind of like this, values are from input:
     * 0 -> 4 (or in English: "beginning on input" -> "I have no idea? I'll guess what they want next!")
     * 2 -> 2 (oh how interesting, I've narrowed down values...)
     * 1 -> 9 (oh how interesting, I've now know what the values are...)
     * then the output looks like: [4, 2, 9,...]
     * so we then remove the erroneous data to get our true output
     */
    return lastOutput;
  }

  /**
   *
   * @param {Object[]|String[]} data an array of objects: `{input: 'string', output: 'string'}` or an array of strings
   * @param {Object} [options]
   * @returns {{error: number, iterations: number}}
   */
  train(data, options = {}) {
    options = Object.assign({}, RnnTimeStep.trainDefaults, options);
    let iterations = options.iterations;
    let errorThresh = options.errorThresh;
    let log = options.log === true ? console.log : options.log;
    let logPeriod = options.logPeriod;
    let learningRate = options.learningRate || this.learningRate;
    let callback = options.callback;
    let callbackPeriod = options.callbackPeriod;
    let error = Infinity;
    let i;

    if (this.hasOwnProperty('setupData')) {
      data = this.setupData(data);
    }

    if (!options.keepNetworkIntact) {
      this.initialize();
    }

    for (i = 0; i < iterations && error > errorThresh; i++) {
      let sum = 0;
      for (let j = 0; j < data.length; j++) {
        let err = this.trainPattern(data[j], learningRate);
        sum += err;
      }
      error = sum / data.length;
      
      if (isNaN(error)) throw new Error('network error rate is unexpected NaN, check network configurations and try again');
      if (log && (i % logPeriod == 0)) {
        log('iterations:', i, 'training error:', error);
      }
      if (callback && (i % callbackPeriod == 0)) {
        callback({ error: error, iterations: i });
      }
    }

    return {
      error: error,
      iterations: i
    };
  }

  /**
   *
   * @param data
   * @returns {
   *  {
   *    error: number,
   *    misclasses: Array
   *  }
   * }
   */
  test(data) {
    throw new Error('not yet implemented');
  }

  /**
   *
   * @returns {Object}
   */
  toJSON() {
    const defaults = RnnTimeStep.defaults;
    let model = this.model;
    let options = {};
    for (let p in defaults) {
      options[p] = this[p];
    }

    return {
      type: this.constructor.name,
      options: options,
      input: model.input.toJSON(),
      hiddenLayers: model.hiddenLayers.map((hiddenLayer) => {
        let layers = {};
        for (let p in hiddenLayer) {
          layers[p] = hiddenLayer[p].toJSON();
        }
        return layers;
      }),
      outputConnector: this.model.outputConnector.toJSON(),
      output: this.model.output.toJSON()
    };
  }

  toJSONString() {
    return JSON.stringify(this.toJSON());
  }

  fromJSON(json) {
    this.json = json;
    const defaults = RnnTimeStep.defaults;
    let model = this.model;
    let options = json.options;
    let allMatrices = model.allMatrices;
    model.input = Matrix.fromJSON(json.input);
    allMatrices.push(model.input);
    model.hiddenLayers = json.hiddenLayers.map((hiddenLayer) => {
      let layers = {};
      for (let p in hiddenLayer) {
        layers[p] = Matrix.fromJSON(hiddenLayer[p]);
        allMatrices.push(layers[p]);
      }
      return layers;
    });
    model.outputConnector = Matrix.fromJSON(json.outputConnector);
    model.output = Matrix.fromJSON(json.output);
    allMatrices.push(model.outputConnector);
    allMatrices.push(model.output);

    for (let p in defaults) {
      if (!defaults.hasOwnProperty(p)) continue;
      this[p] = options.hasOwnProperty(p) ? options[p] : defaults[p];
    }

    if (options.hasOwnProperty('dataFormatter') && options.dataFormatter !== null) {
      this.dataFormatter = DataFormatter.fromJSON(options.dataFormatter);
      delete options.dataFormatter;
    }

    this.bindEquation();
  }

  fromJSONString(json) {
    return this.fromJSON(JSON.parse(json));
  }

  /**
   *
   * @returns {Function}
   */
  toFunction() {
    let model = this.model;
    let equations = this.model.equations;
    let equation = equations[1];
    let states = equation.states;
    let jsonString = JSON.stringify(this.toJSON());

    function matrixOrigin(m, stateIndex) {
      for (let i = 0, max = states.length; i < max; i++) {
        let state = states[i];

        if (i === stateIndex) {
          let j = previousConnectionIndex(m);
          switch (m) {
            case state.left:
              if (j > -1) {
                return `typeof prevStates[${ j }] === 'object' ? prevStates[${ j }].product : new Matrix(${ m.rows }, ${ m.columns })`;
              }
            case state.right:
              if (j > -1) {
                return `typeof prevStates[${ j }] === 'object' ? prevStates[${ j }].product : new Matrix(${ m.rows }, ${ m.columns })`;
              }
            case state.product:
              return `new Matrix(${ m.rows }, ${ m.columns })`;
            default:
              throw Error('unknown state');
          }
        }

        if (m === state.product) return `states[${ i }].product`;
        if (m === state.right) return `states[${ i }].right`;
        if (m === state.left) return `states[${ i }].left`;
      }
    }

    function previousConnectionIndex(m) {
      const connection = model.equationConnections[0];
      const states = equations[0].states;
      for (let i = 0, max = states.length; i < max; i++) {
        if (states[i].product === m) {
          return i;
        }
      }
      return connection.indexOf(m);
    }

    function matrixToString(m, stateIndex) {
      if (!m || !m.rows || !m.columns) return 'null';

      if (m === model.input) return `json.input`;
      if (m === model.outputConnector) return `json.outputConnector`;
      if (m === model.output) return `json.output`;

      for (let i = 0, max = model.hiddenLayers.length; i < max; i++) {
        let hiddenLayer = model.hiddenLayers[i];
        for (let p in hiddenLayer) {
          if (!hiddenLayer.hasOwnProperty(p)) continue;
          if (hiddenLayer[p] !== m) continue;
          return `json.hiddenLayers[${ i }].${ p }`;
        }
      }

      return matrixOrigin(m, stateIndex);
    }

    function toInner(fnString) {
      // crude, but should be sufficient for now
      // function() { body }
      fnString = fnString.toString().split('{');
      fnString.shift();
      // body }
      fnString = fnString.join('{');
      fnString = fnString.split('}');
      fnString.pop();
      // body
      return fnString.join('}').split('\n').join('\n        ')
        .replace('product.deltas[i] = 0;', '')
        .replace('product.deltas[column] = 0;', '')
        .replace('left.deltas[leftIndex] = 0;', '')
        .replace('right.deltas[rightIndex] = 0;', '')
        .replace('product.deltas = left.deltas.slice(0);', '');
    }

    function fileName(fnName) {
      return `src/recurrent/matrix/${ fnName.replace(/[A-Z]/g, function(value) { return '-' + value.toLowerCase(); }) }.js`;
    }

    let statesRaw = [];
    let usedFunctionNames = {};
    let innerFunctionsSwitch = [];
    for (let i = 0, max = states.length; i < max; i++) {
      let state = states[i];
      statesRaw.push(`states[${ i }] = {
      name: '${ state.forwardFn.name }',
      left: ${ matrixToString(state.left, i) },
      right: ${ matrixToString(state.right, i) },
      product: ${ matrixToString(state.product, i) }
    }`);

      let fnName = state.forwardFn.name;
      if (!usedFunctionNames[fnName]) {
        usedFunctionNames[fnName] = true;
        innerFunctionsSwitch.push(
          `        case '${ fnName }': //compiled from ${ fileName(fnName) }
          ${ toInner(state.forwardFn.toString()) }
          break;`
        );
      }
    }

    const src = `
  if (typeof rawInput === 'undefined') rawInput = [];
  if (typeof maxPredictionLength === 'undefined') maxPredictionLength = 100;
  if (typeof isSampleI === 'undefined') isSampleI = false;
  if (typeof temperature === 'undefined') temperature = 1;
  ${ (this.dataFormatter !== null) ? this.dataFormatter.toFunctionString() : '' }
  
  var input = ${
      (this.dataFormatter !== null && typeof this.formatDataIn === 'function')
        ? 'formatDataIn(rawInput)' 
        : 'rawInput'
    };
  var json = ${ jsonString };
  var _i = 0;
  var output = [];
  var states = [];
  var prevStates;
  while (true) {
    var previousIndex = _i < input.length
          ? input[_i - 1]
          : output[_i - 1])
          ;
    var rowPluckIndex = previousIndex;
    prevStates = states;
    states = [];
    ${ statesRaw.join(';\n    ') };
    for (var stateIndex = 0, stateMax = ${ statesRaw.length }; stateIndex < stateMax; stateIndex++) {
      var state = states[stateIndex];
      var product = state.product;
      var left = state.left;
      var right = state.right;
      
      switch (state.name) {
${ innerFunctionsSwitch.join('\n') }
      }
    }
    
    var logProbabilities = state.product;
    if (temperature !== 1 && isSampleI) {
      for (var q = 0, nq = logProbabilities.weights.length; q < nq; q++) {
        logProbabilities.weights[q] /= temperature;
      }
    }

    var probs = softmax(logProbabilities);
    var nextIndex = isSampleI ? sampleI(probs) : maxI(probs);
    
    _i++;
    if (nextIndex === 0) {
      break;
    }
    if (_i >= maxPredictionLength) {
      break;
    }

    output.push(nextIndex);
  }
  ${ (this.dataFormatter !== null && typeof this.formatDataOut === 'function') 
      ? 'return formatDataOut(input, output.slice(input.length).map(function(value) { return value - 1; }))'
      : 'return output.slice(input.length).map(function(value) { return value - 1; })' };
  function Matrix(rows, columns) {
    this.rows = rows;
    this.columns = columns;
    this.weights = zeros(rows * columns);
  }
  ${ this.dataFormatter !== null && typeof this.formatDataIn === 'function'
      ? `function formatDataIn(input, output) { ${
          toInner(this.formatDataIn.toString())
            .replace(/this[.]dataFormatter[\n\s]+[.]/g, '')
            .replace(/this[.]dataFormatter[.]/g, '')
            .replace(/this[.]dataFormatter/g, 'true')
        } }`
      : '' }
  ${ this.dataFormatter !== null && typeof this.formatDataOut === 'function'
        ? `function formatDataOut(input, output) { ${
            toInner(this.formatDataOut.toString())
              .replace(/this[.]dataFormatter[\n\s]+[.]/g, '')
              .replace(/this[.]dataFormatter[.]/g, '')
              .replace(/this[.]dataFormatter/g, 'true')
          } }` 
        : '' }
  ${ zeros.toString() }
  ${ softmax.toString().replace('_2.default', 'Matrix') }
  ${ randomF.toString() }
  ${ sampleI.toString() }
  ${ maxI.toString() }`;
    return new Function('rawInput', 'maxPredictionLength', 'isSampleI', 'temperature', src);
  }
}

RnnTimeStep.defaults = {
  inputSize: 1,
  hiddenSizes:[20],
  outputSize: 1,
  learningRate: 0.01,
  decayRate: 0.999,
  smoothEps: 1e-8,
  regc: 0.000001,
  clipval: 5,
  json: null,
  dataFormatter: null
};

RnnTimeStep.trainDefaults = {
  iterations: 20000,
  errorThresh: 0.005,
  log: false,
  logPeriod: 10,
  learningRate: 0.3,
  callback: null,
  callbackPeriod: 10,
  keepNetworkIntact: false
};