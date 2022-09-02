async function onload(){
    await browser.ResourceUrl.register("rcbf_content", "content/");
    browser.rcmbf_bgrndAPI.onLoad();
}

onload();
