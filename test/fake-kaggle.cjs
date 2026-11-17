// Fake kaggle CLI for testing the cloud flow without touching a real account.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const st=process.env.FAKE_KAGGLE_DIR; fs.mkdirSync(st,{recursive:true});
const a=process.argv.slice(2); const log=(m)=>fs.appendFileSync(path.join(st,'calls.log'),m+'\n'); log(a.join(' '));
const arg=(f)=>a[a.indexOf(f)+1];
const cmd=a.slice(0,2).join(' ');
if(cmd==='config view'){console.log('Configuration values\n- username: tester');}
else if(cmd==='datasets create'){const d=arg('-p');fs.cpSync(d,path.join(st,'ds'),{recursive:true});console.log('Dataset created');}
else if(cmd==='datasets status'){console.log('ready');}
else if(cmd==='kernels push'){const d=arg('-p');fs.cpSync(d,path.join(st,'kern'),{recursive:true});
  const cfg=JSON.parse(fs.readFileSync(path.join(st,'ds','job.json')));
  const r=cp.spawnSync('ffmpeg',['-v','error','-i',path.join(st,'ds','input.mp4'),'-vf',`scale=${cfg.outW}:${cfg.outH}:flags=bicubic`,'-an','-c:v','libx264','-crf','12','-y',path.join(st,'upscaled.mp4')]);
  if(r.status!==0){console.log('ERROR',String(r.stderr));process.exit(1);} fs.writeFileSync(path.join(st,'n'),'0'); console.log('Kernel version 1 successfully pushed');}
else if(cmd==='kernels status'){const f=path.join(st,'n');const n=Number(fs.readFileSync(f,'utf8'));fs.writeFileSync(f,String(n+1));console.log(`tester/x has status "KernelWorkerStatus.${n<1?'RUNNING':'COMPLETE'}"`);}
else if(cmd==='kernels output'){fs.copyFileSync(path.join(st,'upscaled.mp4'),path.join(arg('-p'),'upscaled.mp4'));console.log('downloaded');}
else if(cmd==='kernels logs'){console.log('log');}
else if(cmd==='kernels delete'||cmd==='datasets delete'){console.log('deleted');}
else {console.log('unknown',a.join(' '));process.exit(2);}
