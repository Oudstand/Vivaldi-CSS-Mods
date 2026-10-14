// Run with: node tests/merge-tabbar-addressbar-browser.test.cjs
// Uses a temporary native Vivaldi profile, native toolbar preferences and all CSS mods.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const binary=process.env.MERGE_BAR_BROWSER||['/opt/vivaldi-snapshot/vivaldi-bin','/opt/vivaldi/vivaldi-bin'].find(file=>fs.existsSync(file));
if(!binary)throw Error('Vivaldi is required');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vivaldi-merge-review-'));
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
        const {sessionId}=await call('Target.attachToTarget',{targetId:testTarget.targetId,flatten:true});
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
        await evaluateHere("(async()=>{for(let i=0;i<12;i++)await chrome.tabs.create({windowId:vivaldiWindowId,url:'about:blank#layout-'+i,active:false});})()");
        await delay(500);
        const rects=()=>evaluateHere(`(()=>{
            const box=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
            const field=document.querySelector('.toolbar-tabbar-before > .UrlBar-AddressField');
            const style=getComputedStyle(field);
            return {field:box(field),fieldStyle:{position:style.position,minWidth:style.minWidth,flexShrink:style.flexShrink,target:style.getPropertyValue('--address-bar-target-width')},
                neighbors:[...field.parentElement.children].filter(el=>el!==field&&el.getClientRects().length).map(box),tabs:box(document.querySelector('#tabs-container .resize')),after:box(document.querySelector('.toolbar-tabbar-after')),tabsContainer:box(document.getElementById('tabs-container')),
                controls:box(document.querySelector('.window-buttongroup')),page:box(document.getElementById('webview-container')),viewport:innerWidth};
        })()`);
        const check=(s,idle=s)=>{
            assert.ok(s.field.width>70,'The address field must remain usable');
            assert.ok(s.field.x>=0&&s.field.right<=s.viewport,'The field must remain inside the window');
            assert.equal(s.fieldStyle.position,'relative','Keep native positioning');
            for(let i=0;i<s.neighbors.length;i++){const r=s.neighbors[i],original=idle.neighbors[i];assert.ok(Math.abs(r.x-original.x)<1,'Focus must not move neighboring toolbar items');if(original.right<=idle.field.x+1)assert.ok(s.field.x>=r.right-1,'Keep navigation before the field accessible');else if(idle===s)assert.ok(s.field.right<=r.x+1,'Resting field must not overlap following items');}
            if(s.controls.width&&s.field.y<s.controls.bottom&&s.field.bottom>s.controls.y)assert.ok(s.field.right<=s.controls.x,'Keep the window controls accessible');
        };
        const focus=async value=>{await evaluateHere(value?"document.getElementById('urlFieldInput').focus()":"document.querySelector('.webpageview.active.visible webview').focus()");await delay(300);return rects();};
        const layout=async names=>{
            await focus(false);
            await evaluateHere(`vivaldi.prefs.set({path:'vivaldi.toolbars.tabbar_before',value:${JSON.stringify(names)}})`);
            await until(`JSON.stringify([...document.querySelector('.toolbar-tabbar-before').children].map(el=>el.dataset.name||el.querySelector('button[data-name]')?.dataset.name).filter(Boolean))===${JSON.stringify(JSON.stringify(names))}`,sessionId);
            await delay(100);
        };
        for(const width of [1600,1000,800,640,500]){
            await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false},sessionId);
            const idle=await focus(false),focused=await focus(true);check(idle);check(focused,idle);assert.ok(Math.abs(idle.tabs.x-focused.tabs.x)<1&&Math.abs(idle.tabs.width-focused.tabs.width)<1,'Focus must not shift or resize tabs');
            assert.ok(Math.abs(idle.field.x-focused.field.x)<1,'Focus must not shift the field over navigation buttons');
            assert.ok(focused.field.width>=idle.field.width-1,'Focus must not shrink the field');
            assert.equal(focused.page.y,idle.page.y,'Focusing must not shift the webpage vertically');
            if(width>=1000)assert.ok(idle.controls.x-idle.after.right>=0&&idle.controls.x-idle.after.right<10,'Many tabs must fill the available row up to the window controls');
            if(width===1600){
                assert.ok(focused.field.width>idle.field.width+80,'Keep focus expansion when space is available');
                if(process.env.MERGE_BAR_SCREENSHOTS){
                    await focus(false);fs.writeFileSync(process.env.MERGE_BAR_SCREENSHOTS+'-idle.png',Buffer.from((await call('Page.captureScreenshot',{},sessionId)).data,'base64'));
                    await focus(true);fs.writeFileSync(process.env.MERGE_BAR_SCREENSHOTS+'-focus.png',Buffer.from((await call('Page.captureScreenshot',{},sessionId)).data,'base64'));
                }
            }
        }
        console.log('PASS focus overlays adjacent content without moving tabs or toolbar items at 500–1600 px');
        await call('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false},sessionId);
        for(const names of [
            ['AddressField'],
            ['Back','Forward','Reload','Spacer','AddressField'],
            ['Back','Forward','Reload','SearchField','AddressField'],
            ['Back','Forward','Reload','AddressField','NewTab'],
            ['AddressField','Back','Forward','Reload']
        ]){
            await layout(names);const idle=await focus(false);check(idle);const focused=await focus(true);check(focused,idle);
            const covered=focused.neighbors.find(r=>r.x>=idle.field.right&&r.x<focused.field.right);
            if(covered)assert.equal(await evaluateHere(`document.elementFromPoint(${covered.x+3},${covered.y+covered.height/2})?.closest('.UrlBar-AddressField')===document.querySelector('.toolbar-tabbar-before > .UrlBar-AddressField')`),true,'The expanded field must paint above following items');
        }
        console.log('PASS the field works first, alone, after a spacer or search field and before other buttons');
        await layout(['Back','Forward','Reload','AddressField']);
        await focus(true);
        const tabPoint=await evaluateHere(`(()=>{const field=document.querySelector('.toolbar-tabbar-before > .UrlBar-AddressField').getBoundingClientRect(),tab=[...document.querySelectorAll('#tabs-container .tab:not(.active)')].find(tab=>{const r=tab.getBoundingClientRect();return r.x>field.right+2&&r.right<innerWidth-120;}),r=tab.getBoundingClientRect();return {id:tab.dataset.id,x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        const {id:tabId,...tabCoordinates}=tabPoint;
        await call('Input.dispatchMouseEvent',{type:'mouseMoved',...tabCoordinates},sessionId);
        await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...tabCoordinates},sessionId);
        await delay(250);
        await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...tabCoordinates},sessionId);
        await wait(`document.querySelector('#tabs-container .tab.active')?.dataset.id===${JSON.stringify(tabId)}`);
        console.log('PASS clicking a native tab while the address field is focused still activates that tab');
        await focus(true);
        await call('Input.insertText',{text:'vivaldi://settings/'},sessionId);
        await wait("!!document.querySelector('.OmniDropdown')");
        await wait(`(()=>{const drop=document.querySelector('.OmniDropdown'),r=drop?.getBoundingClientRect(),field=document.querySelector('.toolbar-tabbar-before > .UrlBar-AddressField').getBoundingClientRect();return r&&!!document.elementFromPoint(r.x+r.width/2,field.bottom+10)?.closest('.OmniDropdown');})()`);
        await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);
        await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);
        await focus(false);
        console.log('PASS the native address dropdown opens and remains above page content');
        for(const density of [false,true]){
            await evaluateHere(`vivaldi.prefs.set({path:'vivaldi.appearance.density',value:${density}})`);
            const idle=await focus(false);check(idle);check(await focus(true),idle);
        }
        console.log('PASS both native UI density settings retain a usable layout');
        // The browser UI is rendered by main.html, not the window.html realm.
        const main=(await call('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/main.html'));
        const ui=await call('Target.attachToTarget',{targetId:main.targetId,flatten:true});
        const windowId=await evaluateHere('vivaldiWindowId');
        await evaluate(`webpackChunkgapp_browser_react.push([[Date.now()],{},require=>{
            const id=Object.keys(require.m).find(id=>{const text=require.m[id].toString();return text.includes('TOOLBAR_EDIT_MODE')&&text.includes('stopEditing');});
            if(!id)throw Error('Native toolbar editor API could not be located');
            globalThis.__mergeTestEditor=require(id).Z;
        }]);__mergeTestEditor.edit('vivaldi.toolbars.tabbar_before',${windowId})`,ui.sessionId);
        await wait("!!document.querySelector('.toolbar-editor')");
        const editing=await focus(true);
        assert.equal(editing.fieldStyle.target,'','Merge layout must be disabled in the native editor');
        assert.equal(editing.fieldStyle.flexShrink,'0','The native editor owns sizing');
        assert.equal(editing.fieldStyle.minWidth,'300px');
        await evaluate(`__mergeTestEditor.stopEditing(${windowId});delete globalThis.__mergeTestEditor`,ui.sessionId);
        await wait("!document.querySelector('.toolbar-editor')");
        {const idle=await focus(false);check(idle);check(await focus(true),idle);}
        console.log('PASS the real native toolbar editor restores native sizing and leaving it restores the mod');
        await evaluateHere("vivaldi.prefs.set({path:'vivaldi.tabs.bar.position',value:'left'})");
        await wait("document.getElementById('browser').classList.contains('tabs-left')");
        const vertical=await rects();
        assert.equal(vertical.fieldStyle.target,'','Vertical tabs must keep their native layout');
        await evaluateHere("vivaldi.prefs.set({path:'vivaldi.tabs.bar.position',value:'bottom'})");
        await wait("document.getElementById('browser').classList.contains('tabs-bottom')");
        {const idle=await focus(false);check(idle);check(await focus(true),idle);}
        console.log('PASS the merged layout also works with the horizontal tab bar at the bottom');
        await evaluateHere("vivaldi.prefs.set({path:'vivaldi.tabs.bar.position',value:'top'})");
        await wait("document.getElementById('browser').classList.contains('tabs-top')");
        check(await focus(false));
        console.log('PASS vertical tabs keep native sizing and switching back restores the merged layout');
        await call('Emulation.clearDeviceMetricsOverride',{},sessionId);
        await evaluateHere("chrome.windows.update(vivaldiWindowId,{state:'normal',left:0,top:0,width:640,height:850})");
        const idle=await focus(false),focused=await focus(true);check(idle);check(focused,idle);assert.ok(Math.abs(idle.tabs.x-focused.tabs.x)<1&&Math.abs(idle.tabs.width-focused.tabs.width)<1,'Focus must not shift or resize tabs');
        assert.ok(Math.abs(idle.field.x-focused.field.x)<1);
        console.log('PASS an actual 640 px native window also preserves navigation while editing the address');
    } finally {
        ws?.close();child.kill('SIGTERM');
        await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2500);child.once('exit',()=>{clearTimeout(timer);resolve();});});
        fs.rmSync(profile,{recursive:true,force:true});
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
