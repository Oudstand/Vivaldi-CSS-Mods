// Run with: node tests/edge-like-border-browser.test.cjs
// Uses a temporary native Vivaldi profile, native toolbar preferences and all CSS mods.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const binary=process.env.EDGE_BORDER_BROWSER||['/opt/vivaldi-snapshot/vivaldi-bin','/opt/vivaldi/vivaldi-bin'].find(file=>fs.existsSync(file));
if(!binary)throw Error('Vivaldi is required');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vivaldi-edge-review-'));
    const child = spawn(binary, ['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-sync','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'], {stdio:['ignore','ignore','pipe']});
    let ws;
    try {
        const endpoint = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('No DevTools endpoint')), 15000);
            child.stderr.on('data', data => {const match = data.toString().match(/DevTools listening on (ws:\/\/\S+)/); if (match) {clearTimeout(timer); resolve(match[1]);}});
            child.on('exit', code => {clearTimeout(timer); reject(Error('Browser exited: '+code));});
        });
        ws = new WebSocket(endpoint); await new Promise((resolve, reject) => {ws.onopen=resolve; ws.onerror=reject;});
        let sequence=0; const pending=new Map();
        ws.onmessage = event => {const msg=JSON.parse(event.data); if (!msg.id) return; const p=pending.get(msg.id); pending.delete(msg.id); if (p) msg.error ? p.reject(Error(JSON.stringify(msg.error))) : p.resolve(msg.result);};
        const call = (method, params={}, sessionId) => new Promise((resolve, reject) => {
            const id=++sequence, timer=setTimeout(() => {pending.delete(id); reject(Error('CDP timeout: '+method));}, 10000);
            pending.set(id, {resolve:r=>{clearTimeout(timer); resolve(r);}, reject:e=>{clearTimeout(timer); reject(e);}});
            ws.send(JSON.stringify({id, method, params, sessionId}));
        });
        const evaluate = async (expression, sessionId) => {
            const result=await call('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true,includeCommandLineAPI:true}, sessionId)
                .catch(error => {throw Error(error.message+' evaluating '+expression.slice(0,160));});
            if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
        };
        const until = async (expression, sessionId) => {for (let i=0;i<80;i++) {const value=await evaluate(expression,sessionId); if (value) return value; await delay(100);} throw Error('Timed out: '+expression);};
        await delay(1500);
        const targets=await call('Target.getTargets'),target=targets.targetInfos.find(t=>t.url.endsWith('/window.html'));
        const initial=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
        await evaluate("chrome.storage.local.set({fullScreenModEnabled:false}).then(()=>chrome.windows.create({url:'about:blank',type:'normal'}))",initial.sessionId);
        let testTarget;
        for(let i=0;i<80&&!testTarget;i++){
            testTarget=(await call('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/window.html')&&t.targetId!==target.targetId);
            if(!testTarget)await delay(100);
        }
        assert.ok(testTarget,'A fresh native window is required to disable the installed fullscreen mod');
        let {sessionId}=await call('Target.attachToTarget',{targetId:testTarget.targetId,flatten:true});
        const evaluateHere=expression=>evaluate(expression,sessionId), wait=expression=>until(expression,sessionId);
        await wait("!!document.getElementById('browser')&&!!document.getElementById('webview-container')");
        await wait("!document.getElementById('app').classList.contains('fullscreen-listener-enabled')");
        await evaluateHere(`(async()=>{
            await vivaldi.prefs.set({path:'vivaldi.toolbars.navigation',value:[]});
            await vivaldi.prefs.set({path:'vivaldi.toolbars.tabbar_before',value:['Back','Forward','Reload','AddressField']});
        })()`);
        await wait("!!document.querySelector('#tabs-container > .toolbar-tabbar-before .UrlBar-AddressField')");
        const cssDir=path.resolve(__dirname,'..');
        for(const file of fs.readdirSync(cssDir).filter(f=>f.endsWith('.css')).sort())await evaluateHere(`(()=>{const style=document.createElement('style');style.dataset.reviewFile=${JSON.stringify(file)};style.textContent=${JSON.stringify(fs.readFileSync(path.join(cssDir,file),'utf8'))};document.head.append(style);})()`);
        await call('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false},sessionId);

        let passed=0;
        const check=async(label,run)=>{await run();passed++;console.log('PASS',label);};
        const pref=(path,value)=>evaluateHere(`vivaldi.prefs.set({path:${JSON.stringify(path)},value:${JSON.stringify(value)}})`);
        const metrics=()=>evaluateHere(`(()=>{
            const box=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
            const panels=document.getElementById('panels-container'),group=panels.querySelector('.panel-group'),page=document.getElementById('webpage-stack');
            const frame=getComputedStyle(page,'::before'),border=getComputedStyle(panels,'::after'),style=getComputedStyle(page),panelFrame=group&&getComputedStyle(group,'::before');
            return {viewport:innerWidth,panels:box(panels),group:group&&box(group),page:box(page),marginLeft:parseFloat(style.marginLeft),marginRight:parseFloat(style.marginRight),frameZ:+frame.zIndex,frameEvents:frame.pointerEvents,
                panelFrame:panelFrame&&{width:parseFloat(panelFrame.width),height:parseFloat(panelFrame.height),events:panelFrame.pointerEvents,topLeft:panelFrame.borderTopLeftRadius,topRight:panelFrame.borderTopRightRadius},
                border:{left:border.left,right:border.right,events:border.pointerEvents,topLeft:border.borderTopLeftRadius,topRight:border.borderTopRightRadius}};
        })()`);
        const togglePanel=async()=>{
            const point=await evaluateHere(`(()=>{const r=document.querySelector('#switch button[data-name="PanelBookmarks"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
            await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point},sessionId);
            await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point},sessionId);
            await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point},sessionId);
        };
        const setPanelOpen=async open=>{
            if(await evaluateHere("!document.getElementById('panels-container').classList.contains('icons')")!==open)await togglePanel();
            await wait(`!document.getElementById('panels-container').classList.contains('icons')===${open}`);
            await delay(600);
        };
        const checkOpen=s=>{
            assert.ok(s.group.width>250,'Panel content must retain its native width');
            assert.ok(s.group.x>=0&&s.group.right<=s.viewport,'Panel content must stay inside the window');
            assert.ok(s.group.height>500,'Panel content must retain its height');
            assert.ok(Math.abs(s.panelFrame.width-s.group.width)<2,'Fixed decoration must fit its panel');
            assert.ok(Math.abs(s.panelFrame.height-s.group.height)<2,'Fixed decoration must fit its panel height');
            assert.equal(s.panelFrame.events,'none','Decoration must not intercept input');
        };
        for(const density of [true,false]){
            await pref('vivaldi.appearance.density',density);
            await wait(`document.getElementById('browser').classList.contains('density-on')===${density}`);
            for(const side of ['left','right']){
                await pref('vivaldi.panels.position',side);
                await wait(`document.getElementById('panels-container').classList.contains('${side}')`);
                for(const overlay of [false,true]){
                    await check(`${density?'compact':'regular'} ${side} ${overlay?'floating':'docked'} panel`,async()=>{
                        await pref('vivaldi.panels.as_overlay.enabled',overlay);
                        await wait(`document.getElementById('panels-container').classList.contains('overlay')===${overlay}`);
                        await setPanelOpen(true);
                        const s=await metrics();checkOpen(s);
                        if(overlay){
                            if(side==='left')assert.ok(s.group.x>=s.panels.right,'Left floating panel must face the page');
                            else assert.ok(s.group.right<=s.panels.x,'Right floating panel must face the page');
                        }else assert.ok(s.panels.width>300,'Docked container must expand with the panel');
                        assert.equal(s.panelFrame[side==='left'?'topLeft':'topRight'],'8px','Panel corners must follow its side');
                        await setPanelOpen(false);
                        const closed=await metrics();
                        assert.ok(closed.page.width>s.page.width+200||overlay,'Closing a docked panel must return space to the page');
                        assert.equal(closed.marginLeft,s.marginLeft,'Opening panels must preserve the page frame spacing');
                        assert.equal(closed.marginRight,s.marginRight,'Opening panels must preserve the page frame spacing');
                    });
                }
            }
        }
        await pref('vivaldi.appearance.density',true);
        await pref('vivaldi.panels.position','left');
        await pref('vivaldi.panels.as_overlay.enabled',true);
        const radius=await evaluateHere("document.getElementById('browser').style.getPropertyValue('--radius')");
        for(const value of [0,6,16]){
            await check(`page radius ${value}px`,async()=>{
                await evaluateHere(`document.getElementById('browser').style.setProperty('--radius','${value}px')`);
                await delay(600);
                const s=await metrics();
                assert.equal(s.marginLeft,value/2);assert.equal(s.marginRight,value/2);
                assert.equal(s.frameZ,15);assert.equal(s.frameEvents,'none');
            });
        }
        await evaluateHere(`document.getElementById('browser').style.setProperty('--radius',${JSON.stringify(radius)})`);
        await check('Ribbon floating panels also work without the edge mod',async()=>{
            await evaluateHere("document.querySelector('style[data-review-file=\"edge-like-border.css\"]').disabled=true");
            await pref('vivaldi.panels.position','right');await setPanelOpen(true);
            const s=await metrics();
            assert.ok(s.group.width>250&&s.group.x>=0&&s.group.right<=s.viewport,'Ribbon offsets need a valid fallback');
            await setPanelOpen(false);
            await evaluateHere("document.querySelector('style[data-review-file=\"edge-like-border.css\"]').disabled=false");
        });
        await check('real dialog keeps the page frame above its backdrop',async()=>{
            // Load the current dialog class without creating its global startup instance.
            const source=fs.readFileSync(path.resolve(cssDir,'../JS/dialog.js'),'utf8')
                .replaceAll('dialog.mod.searchMenus','dialog.mod.searchMenus.edgeTest')
                .replace('queueMicrotask(initDialog);','')
                .replace(/\}\)\(\);\s*$/, 'window.__edgeDialogClass=DialogMod;})();');
            await evaluateHere(source);
            await evaluateHere('window.__edgeDialog=new __edgeDialogClass();__edgeDialog.searchEngineUtils.ready');
            const id=await evaluateHere("(()=>{__edgeDialog.showDialog('about:blank',false);return [...__edgeDialog.webviews.keys()].at(-1);})()");
            await wait(`__edgeDialog.webviews.get(${JSON.stringify(id)})?.divContainer.isConnected`);
            await delay(500);
            const dialog=await evaluateHere(`(()=>{const d=__edgeDialog.webviews.get(${JSON.stringify(id)}).divContainer;return {z:+getComputedStyle(d).zIndex,withinPage:!!d.closest('#webpage-stack')};})()`);
            const s=await metrics();
            assert.equal(dialog.withinPage,true);assert.ok(s.frameZ>dialog.z);assert.equal(s.frameEvents,'none');
            await evaluateHere(`__edgeDialog.removeDialog(${JSON.stringify(id)})`);
            await delay(400);
        });
        await check('native toolbar editor suppresses the automated bookmark frame',async()=>{
            await pref('vivaldi.bookmarks.bar.visible',true);
            await pref('vivaldi.bookmarks.bar.position','top');
            await evaluateHere("(()=>{const button=document.createElement('button');button.title='automate-bookmark-bar';document.getElementById('switch').append(button);})()");
            await wait("getComputedStyle(document.querySelector('.bookmark-bar'),'::after').content!==\"none\"");
            const mainTarget=(await call('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/main.html'));
            const main=await call('Target.attachToTarget',{targetId:mainTarget.targetId,flatten:true});
            await evaluate(`webpackChunkgapp_browser_react.push([[Date.now()],{},require=>{
                const id=Object.keys(require.m).find(id=>{const text=require.m[id].toString();return text.includes('TOOLBAR_EDIT_MODE')&&text.includes('stopEditing');});
                globalThis.__edgeEditor=require(id).Z;
            }]);`,main.sessionId);
            const windowId=await evaluateHere('vivaldiWindowId');
            await evaluate(`__edgeEditor.edit('vivaldi.toolbars.tabbar_before',${windowId})`,main.sessionId);
            await wait("!!document.querySelector('.toolbar-editor')");
            assert.equal(await evaluateHere("getComputedStyle(document.querySelector('.bookmark-bar'),'::after').content"),'none');
            await evaluate(`__edgeEditor.stopEditing(${windowId})`,main.sessionId);
            await wait("!document.querySelector('.toolbar-editor')");
        });
        // Enable the installed fullscreen mod in a fresh window so its real layout and hover handlers run.
        await pref('vivaldi.panels.position','left');
        await pref('vivaldi.panels.as_overlay.enabled',true);
        await evaluateHere("chrome.storage.local.set({fullScreenModEnabled:true})");
        const previousTarget=testTarget.targetId;
        await evaluateHere("chrome.windows.create({url:'about:blank',type:'normal'})");
        let fullscreenTarget;
        for(let i=0;i<80&&!fullscreenTarget;i++){
            fullscreenTarget=(await call('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/window.html')&&t.targetId!==previousTarget&&t.targetId!==target.targetId);
            if(!fullscreenTarget)await delay(100);
        }
        assert.ok(fullscreenTarget,'A fresh fullscreen-mod window is required');
        ({sessionId}=await call('Target.attachToTarget',{targetId:fullscreenTarget.targetId,flatten:true}));
        await wait("document.getElementById('app')?.classList.contains('fullscreen-listener-enabled')");
        await call('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false},sessionId);
        for(const file of fs.readdirSync(cssDir).filter(f=>f.endsWith('.css')).sort())await evaluateHere(`(()=>{const style=document.createElement('style');style.dataset.reviewFile=${JSON.stringify(file)};style.textContent=${JSON.stringify(fs.readFileSync(path.join(cssDir,file),'utf8'))};document.head.append(style);})()`);
        const panelBorderQuad=async()=>{
            const {root}=await call('DOM.getDocument',{depth:-1,pierce:true},sessionId);
            const find=node=>{
                if(node.attributes?.some((value,i)=>value==='id'&&node.attributes[i+1]==='panels-container'))return node;
                for(const child of node.children||[]){const result=find(child);if(result)return result;}
            };
            const pseudo=find(root)?.pseudoElements?.find(p=>p.pseudoType==='after');
            assert.ok(pseudo,'The side frame must exist');
            return (await call('DOM.getBoxModel',{nodeId:pseudo.nodeId},sessionId)).model.border;
        };
        for(const side of ['left','right']){
            await check(`fullscreen mod ${side} panel frame`,async()=>{
                await pref('vivaldi.panels.position',side);await delay(800);
                // Disable motion only for the measurement; reveal using the mod's actual hover handler.
                await evaluateHere(`document.getElementById('panels-container').style.setProperty('transition','none','important');document.querySelector('.hover-div.${side}').dispatchEvent(new Event('pointerenter'))`);
                await wait(`!document.getElementById('app').classList.contains('hidden-${side}')`);
                await delay(200);
                const s=await metrics(),quad=await panelBorderQuad(),xs=quad.filter((_,i)=>i%2===0);
                assert.ok(Math.min(...xs)>=0&&Math.max(...xs)<=s.viewport,'Side frame must stay inside the window');
                if(side==='left')assert.ok(Math.max(...xs)>s.panels.right,'Frame must face the page');
                else assert.ok(Math.min(...xs)<s.panels.x,'Frame must face the page');
                assert.equal(s.border[side==='left'?'topLeft':'topRight'],'16px');
                assert.equal(s.border.events,'none');
            });
        }
        console.log(`${passed} native Vivaldi regression cases passed.`);
    } finally {
        ws?.close();child.kill('SIGTERM');
        await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2500);child.once('exit',()=>{clearTimeout(timer);resolve();});});
        fs.rmSync(profile,{recursive:true,force:true});
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
