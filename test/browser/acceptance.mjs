export function computedAudit() {
  const blend=(a,b)=>[0,1,2].map(i=>a[i]*a[3]+b[i]*(1-a[3])).concat(1);
  const rgba=s=>{const n=s.match(/[\d.]+/g)?.map(Number)||[];return [n[0]||0,n[1]||0,n[2]||0,n.length>3?n[3]:1];};
  const lum=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
  const failures=[],sizes=[],contrasts=[];
  const bg=el=>{const chain=[];for(let n=el;n;n=n.parentElement)chain.push(n);return chain.reverse().reduce((b,n)=>blend(rgba(getComputedStyle(n).backgroundColor),b),[255,255,255,1]);};
  const visible=el=>{const st=getComputedStyle(el),r=el.getBoundingClientRect();return r.width&&r.height&&st.visibility!=="hidden"&&st.display!=="none"&&!el.closest("[hidden]");};
  const check=(el,text,pseudo=null)=>{
    if(!visible(el))return;
    const st=getComputedStyle(el,pseudo),color=rgba(st.color),background=bg(el);
    let opacity=1;for(let n=el;n;n=n.parentElement)opacity*=Number(getComputedStyle(n).opacity);
    color[3]*=opacity;
    const fg=blend(color,background),a=lum(fg),b=lum(background),contrast=(Math.max(a,b)+.05)/(Math.min(a,b)+.05),size=parseFloat(st.fontSize);
    sizes.push(size);contrasts.push(contrast);
    if(size<12||contrast<4.5)failures.push({tag:el.tagName,class:String(el.className),text:text.slice(0,100),size,contrast:+contrast.toFixed(3),color:st.color,background});
  };
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){const node=walker.currentNode;if(node.textContent.trim()&&!node.parentElement.closest("script,style,svg"))check(node.parentElement,node.textContent.trim());}
  for(const el of document.querySelectorAll("input,textarea"))if(el.getAttribute("placeholder"))check(el,el.getAttribute("placeholder"),"::placeholder");
  for(const el of document.querySelectorAll("body *"))for(const pseudo of ["::before","::after"]){const content=getComputedStyle(el,pseudo).content;if(content&&content!=="none"&&content!=="normal"&&content!=='""')check(el,content,pseudo);}
  for(const el of document.querySelectorAll("button,input:not([type=file]),textarea")){
    if(!visible(el))continue;
    const size=parseFloat(getComputedStyle(el).fontSize),minimum=el.matches("button")?14:16;
    if(size<minimum)failures.push({tag:el.tagName,class:String(el.className),text:"Control font",size,minimum});
  }
  return {texts:sizes.length,minFont:Math.min(...sizes),minContrast:+Math.min(...contrasts).toFixed(3),overflow:document.documentElement.scrollWidth>innerWidth,failures};
}

export default async function auditBrowser(page, { baseURL, emptyURL, outputDirectory }) {
  const out = outputDirectory;
  const base=baseURL, results=[], assertions=[], requests=[];
  page.on("request",request=>{if(request.url().includes("/api/"))requests.push(new URL(request.url()).pathname);});
  const verify=(condition,name)=>{assertions.push({name,pass:!!condition});if(!condition)throw Error(name);};
  async function audit(name,width) {
    await page.evaluate(async()=>{await document.fonts.ready;});
    results.push({name,width,...await page.evaluate(computedAudit)});
  }
  async function shot(name){await page.screenshot({path:`${out}/${name}.png`,fullPage:true});}
  async function go(path){await page.goto(base+path,{waitUntil:"domcontentloaded"});}
  async function choose(status){await page.locator(".claim-queue li").filter({hasText:`Isolated QA ${status}:`}).locator("button").click();await page.locator(".buyer-message blockquote").filter({hasText:`Isolated QA ${status}:`}).waitFor();await page.locator(".comparison-image img").first().waitFor();}
  try {
    await go("/seller");
    const state=await(await page.request.get(base+"/__qa/state")).json(),cases=state.cases;
    await page.request.post(base+"/api/seller/logout",{headers:{origin:base},data:{}});
    for(const [width,height] of [[1280,800],[390,844]]) {
      await page.setViewportSize({width,height});
      await page.route(base+"/api/config",async route=>{
        const response=await route.fetch(),config=await response.json();
        await route.fulfill({response,json:{...config,catalog:config.catalog.map(product=>({...product,image:""}))}});
      });
      await go("/shop");
      await page.getByRole("heading",{name:"A test store for damage claims.",exact:true}).waitFor();
      await page.locator(".loading-state").waitFor({state:"hidden"});
      verify(await page.locator(".product-photo-placeholder").count()===1,`Only the available product has a missing-photo placeholder at ${width}`);
      await audit("shop-missing-images",width);await shot(`shop-missing-images-${width}`);
      await page.unroute(base+"/api/config");
      await go("/shop");
      await page.getByRole("heading",{name:"A test store for damage claims.",exact:true}).waitFor();
      await page.locator(".loading-state").waitFor({state:"hidden"});
      await page.evaluate(async()=>{await document.fonts.ready;});
      verify(await page.locator(".hero-copy > .eyebrow").textContent()==="Break or Fake demo"&&await page.locator(".hero-copy > .eyebrow + h1").count()===1,`Demo identity above the shop heading at ${width}`);
      verify(await page.locator(".hero-copy > p").innerText()==="Anyone can now fake a damage photo with one prompt. Break or Fake checks the claim before a PayPal refund moves. Real damage gets refunded. Doubtful photos wait for the seller. This is a sandbox test store, so no real money moves.",`Exact shop introduction at ${width}`);
      verify(await page.getByRole("heading",{name:"Test products.",exact:true}).count()===1,`Availability-neutral product heading at ${width}`);
      verify(await page.locator(".product-card").count()===1&&await page.locator(".product-card#judge-cup").count()===1,`Unavailable mug and linen are not selectable at ${width}`);
      verify(await page.locator(".product-card").evaluate(card=>Math.abs(card.getBoundingClientRect().right-document.querySelector(".product-grid").getBoundingClientRect().right)<=1),`Single product fills its product grid at ${width}`);
      const ctas=await page.locator(".hero-actions a").evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {text:el.textContent,bottom:r.bottom,aboveFold:r.top>=0&&r.bottom<=innerHeight};}));
      verify(ctas.length===2&&ctas.every(x=>x.aboveFold),`Both CTAs above fold at ${width}`);
      const photos=await page.locator(".product-photo").evaluateAll(images=>Promise.all(images.map(async image=>{
        await image.decode();return {alt:image.alt,width:image.naturalWidth,height:image.naturalHeight};
      })));
      verify(photos.length===1&&photos.every(image=>image.alt&&image.width===1200&&image.height===800),`Available product has a loaded named catalog image at ${width}`);
      verify(await page.locator("table").count()===1&&await page.locator("#whats-real tbody tr").count()===5,`One five-category truth table at ${width}`);
      verify(await page.getByRole("rowheader",{name:"Shop pictures",exact:true}).locator("..").innerText()==="Shop pictures\tSynthetic catalog art. Not photos of real stock, and never used as evidence.",`Catalog art disclosure at ${width}`);
      verify(await page.locator("footer").innerText()==="Sunday Supply is a sandbox test store for the Break or Fake demo. No real money.",`Exact footer at ${width}`);
      await page.locator(".brand").click();await page.locator(".skip-link").evaluate(link=>link.focus());
      verify(await page.locator(".skip-link").evaluate(link=>!link.matches(":focus-visible")&&link.getBoundingClientRect().bottom<=0),`Mouse focus keeps the skip pill hidden at ${width}`);
      await page.keyboard.press("Tab");await page.keyboard.press("Shift+Tab");
      verify(await page.locator(".skip-link").evaluate(link=>link.matches(":focus-visible")&&link.getBoundingClientRect().top>=0),`Keyboard focus reveals the skip link at ${width}`);
      await page.locator(".skip-link").evaluate(link=>link.blur());
      await audit("shop",width);results.at(-1).ctas=ctas;await shot(`shop-${width}`);
      await page.locator(".product-card").first().click();
      await page.getByRole("link",{name:"Try it with a paper cup ($25)",exact:true}).click();
      verify(await page.locator("#judge-cup").getAttribute("aria-pressed")==="true",`Cup CTA selects and scrolls to judge card at ${width}`);
      await page.locator(".main-nav").getByRole("link",{name:"What's real",exact:true}).click();
      verify(page.url().endsWith("#whats-real"),`Truth-table navigation at ${width}`);
      await page.route(base+"/api/config",async route=>{
        const response=await route.fetch(),config=await response.json();
        await route.fulfill({response,json:{...config,catalog:config.catalog.map(product=>({...product,available:true}))}});
      });
      await go("/shop");
      await page.locator(".loading-state").waitFor({state:"hidden"});
      verify(await page.locator(".product-card").count()===3,`Newly available listings reappear from catalog availability at ${width}`);
      verify((await page.locator(".product-card h3").allTextContents()).join("|")==="Everyday linen|The everyday mug|The paper-cup test",`Restored listings retain their catalog titles at ${width}`);
      await audit("shop-restored-listings",width);
      await page.unroute(base+"/api/config");
      await go("/seller");await page.getByRole("heading",{name:"Sign in",exact:true}).waitFor();
      verify(await page.locator(".seller-workspace,.evaluation-panel,.inset-tabs").count()===0,`Public seller has sign-in only at ${width}`);
      await audit("public-seller",width);await shot(`public-seller-${width}`);
      await go(`/claim/${cases.held.id}`);
      await page.getByRole("heading",{name:"This claim opens only from its private link.",exact:true}).waitFor();
      await audit("private-link-refusal",width);
      await go("/capture");
      verify(await page.locator('head link[rel="icon"][type="image/svg+xml"]').getAttribute("href")==="/favicon.svg",`Capture declares the SVG favicon at ${width}`);
      verify((await page.request.get(base+"/favicon.svg")).status()===200,`Capture favicon is served locally at ${width}`);
      await audit("standalone-capture",width);await shot(`capture-${width}`);
    }
    await go("/seller");await page.getByLabel("Password",{exact:true}).fill("viewer-password-for-tests");await page.getByRole("button",{name:"Open the queue",exact:true}).click();await page.locator(".claim-queue").waitFor();
    for(const [width,height] of [[1280,800],[390,844]]) {
      await page.setViewportSize({width,height});
      for(const status of ["held","awaiting_live","refunded","reviewing","refund_pending"]) {
        await choose(status);await page.locator(".payment-details summary").click();
        verify(await page.locator("#refund-amount").count()===0,`Viewer has no refund form for ${status} at ${width}`);
        await audit(`viewer-${status}`,width);
      }
      await shot(`viewer-${width}`);
    }
    const before=(await(await page.request.get(base+"/__qa/state")).json()).refundCalls;
    const forbidden=await page.request.post(`${base}/api/seller/claims/${cases.held.id}/refund`,{headers:{origin:base},data:{amountCents:2500}});
    verify(forbidden.status()===403,"Viewer refund POST is 403");
    verify((await(await page.request.get(base+"/__qa/state")).json()).refundCalls===before,"Viewer refund POST makes no payment call");
    await page.getByRole("button",{name:"Sign out",exact:true}).click();await page.getByRole("heading",{name:"Sign in",exact:true}).waitFor();
    verify((await page.request.get(base+"/api/seller/claims")).status()===401,"Sign-out removes queue access");
    await page.getByLabel("Password",{exact:true}).fill("seller-password-for-tests");await page.getByRole("button",{name:"Open the queue",exact:true}).click();await page.locator(".claim-queue").waitFor();
    for(const [width,height] of [[1280,800],[390,844]]) {
      await page.setViewportSize({width,height});
      for(const status of ["held","awaiting_live","refunded","reviewing","refund_pending"]) {
        await choose(status);
        verify(await page.locator("#refund-amount").count()===(["held","awaiting_live"].includes(status)?1:0),`Seller form follows case permission for ${status} at ${width}`);
        await audit(`seller-${status}`,width);
      }
      await choose("held");
      await page.getByLabel("Refund amount · USD").fill("25.01");
      verify(await page.getByRole("button",{name:"Review sandbox refund",exact:true}).isDisabled(),`Over-balance amount rejected at ${width}`);
      await page.getByLabel("Refund amount · USD").fill("25.00");await page.getByRole("button",{name:"Review sandbox refund",exact:true}).click();
      await page.getByRole("dialog").waitFor();await audit("seller-confirmation",width);await shot(`seller-confirmation-${width}`);
      await page.getByRole("button",{name:"Keep reviewing",exact:true}).click();
    }
    for(const [width,height] of [[1280,800],[390,844]]) {
      await page.setViewportSize({width,height});
      await go(`/claim/${cases.unclaimed.id}?order=1#token=${cases.unclaimed.token}`);
      await page.getByRole("heading",{name:"What happened?",exact:true}).waitFor();
      verify(await page.getByRole("button",{name:"Submit claim",exact:true}).isDisabled(),`Upload claim waits for evidence at ${width}`);
      await audit("buyer-report-upload",width);
      await page.getByRole("button",{name:"Live photos Three angles, one code",exact:true}).click();await audit("buyer-report-live",width);
      for(const status of ["held","awaiting_live","refunded","reviewing","refund_pending"]) {
        await go(`/claim/${cases[status].id}#token=${cases[status].token}`);
        await page.locator(".claim-result").waitFor();
        if(status==="awaiting_live"){await page.getByRole("button",{name:"Continue on my phone",exact:true}).click();await page.locator(".additional-photo summary").click();}
        await audit(`buyer-${status}`,width);
      }
      await shot(`buyer-${width}`);
    }
    let cameraLabelLength=88;
    await page.route(base+"/api/seller/claims",async route=>{
      const response=await route.fetch(),body=await response.json();
      body.claims=body.claims.filter(x=>x.id===cases.held.id);body.claims[0].order.listingImageUrl="";
      body.claims[0].evidenceKind="live";body.claims[0].cameraLabel="a".repeat(cameraLabelLength);
      await route.fulfill({response,json:body});
    });
    await go("/seller");await page.locator(".comparison-panel").waitFor();
    verify(await page.locator(".comparison-grid figcaption").filter({hasText:"Original listing"}).count()===0,"No listing label when listing is absent");
    verify(await page.locator(".case-overview .field-hint .mono").textContent()==="a".repeat(40)+"…","Seller truncates an 88-character camera label to 40 characters plus an ellipsis");
    for(const length of [40,41,200]){
      cameraLabelLength=length;await go("/seller");await page.locator(".comparison-panel").waitFor();
      verify(await page.locator(".case-overview .field-hint .mono").textContent()==="a".repeat(Math.min(40,length))+(length>40?"…":""),`Camera-label display boundary at ${length} characters`);
    }
    await audit("no-listing-contract",390);await page.unroute(base+"/api/seller/claims");
    await page.addInitScript(()=>{
      const canvas=document.createElement("canvas");canvas.width=640;canvas.height=480;const ctx=canvas.getContext("2d");ctx.fillStyle="#bbaaaa";ctx.fillRect(0,0,640,480);
      Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:async()=>{const stream=canvas.captureStream(10);setInterval(()=>{ctx.fillStyle="#bbaaab";ctx.fillRect(0,0,640,480);},100);return stream;}}});
    });
    for(const [width,height] of [[1280,800],[390,844]]) {
      await page.setViewportSize({width,height});
      await go(`/capture?claim=${cases.awaiting_live.id}&qaViewport=${width}#token=${cases.awaiting_live.token}`);
      await page.getByRole("button",{name:"Start camera and session",exact:true}).click();await page.locator("#challenge").waitFor({state:"visible"});
      await audit("active-capture-challenge",width);await shot(`capture-challenge-${width}`);
      await page.getByRole("button",{name:"Cancel and stop camera",exact:true}).click();
      verify(await page.locator("#camera").evaluate(video=>video.srcObject===null),`Cancel stops camera at ${width}`);
      await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw Error("Camera permission denied");};});
      await page.getByRole("button",{name:"Start camera and session",exact:true}).click();await page.getByText("Camera permission denied",{exact:true}).waitFor();await audit("capture-denied",width);
    }
    await page.goto(emptyURL+"/seller",{waitUntil:"domcontentloaded"});await page.getByLabel("Password",{exact:true}).fill("viewer-password-for-tests");await page.getByRole("button",{name:"Open the queue",exact:true}).click();await page.getByRole("heading",{name:"No claims yet.",exact:true}).waitFor();
    verify(await page.getByRole("heading",{name:"Select a claim.",exact:true}).count()===1,"Empty queue shows selection prompt");
    await audit("empty-viewer-queue",390);
    verify(!requests.includes("/api/demo/claims")&&!requests.includes("/api/evaluation"),"No removed sample or seller evaluation API requests");
    verify(results.every(r=>!r.failures.length&&!r.overflow),"All computed style and overflow checks pass");
    return {assertions,results,views:results.length,minFont:Math.min(...results.map(r=>r.minFont)),minContrast:Math.min(...results.map(r=>r.minContrast)),failures:results.filter(r=>r.failures.length||r.overflow),ctas:results.filter(r=>r.ctas).map(r=>({width:r.width,ctas:r.ctas}))};
  } catch(error) {
    return {assertions,results,error:String(error),failures:results.filter(r=>r.failures.length||r.overflow)};
  } finally {
    await shot("browser-last-state");
  }
}
