import '../env.mjs';
// Offline tuning: oracle = feature labels, fixed latency. node tune.mjs [latency_ms]
import { newState, step, modelState } from '../sim.mjs';
const L=+(process.argv[2]||500)/1000, starts = [{ x: 40 }, { x: 135, vx: 2 }, { x: 80, vx: -3, y: 100 }, { x: 20, y: 140 }];
let land=0;for(let k=0;k<60;k++){const st=k<4?starts[k]:{x:20+Math.random()*80,vx:(Math.random()-.5)*4};const s=newState(st);let d=[false,'center'];
while(!s.outcome){const m=modelState(s);const nd=[m.engine==='burn',m.steer==='none'?'center':m.steer];for(let t=0;t<L&&!s.outcome;t+=1/60)step(s,1/60,d[0],d[1]);d=nd;}
if(s.outcome==='LANDED')land++;if(k<4)console.log(JSON.stringify(st),s.outcome,s.t.toFixed(1),s.fuel.toFixed(0));}
console.log('landed',land,'/60');
