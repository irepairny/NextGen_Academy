const $ = id => document.getElementById(id);
const money = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(n||0));
let dashboardData = null;
let paypalSdkPromise = null;

async function api(url, options={}) {
  const response = await fetch(url, {
    credentials:"same-origin",
    ...options,
    headers:{"Content-Type":"application/json", ...(options.headers||{})}
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function show(view) {
  ["public-view","login-view","dashboard-view"].forEach(id => $(id).classList.toggle("hidden", id !== view));
  $("footer").classList.toggle("hidden", view === "dashboard");
  window.scrollTo({top:0,behavior:"smooth"});
}
function message(id, text, isError=false) {
  const el=$(id); el.textContent=text; el.className=isError?"error":"success";
}
async function login(e) {
  e.preventDefault();
  message("login-error","");
  try {
    await api("/api/auth/login",{method:"POST",body:JSON.stringify({username:$("username").value.trim(),password:$("password").value})});
    $("password").value="";
    await loadDashboard();
    show("dashboard-view");
  } catch(err) { message("login-error",err.message,true); }
}
async function logout() {
  try { await api("/api/auth/logout",{method:"POST",body:"{}"}); } catch {}
  dashboardData=null; show("public-view");
}
async function loadDashboard() {
  dashboardData=await api("/api/student/dashboard");
  $("student-name").textContent=dashboardData.user.fullName;
  $("course-count").textContent=dashboardData.courses.length;
  $("paid-amount").textContent=money(dashboardData.tuition.paid);
  $("tuition-balance").textContent=money(dashboardData.tuition.balance);
  $("overview-balance").textContent=money(dashboardData.tuition.balance);
  $("total-tuition").textContent=money(dashboardData.tuition.total);
  const paid=Number(dashboardData.tuition.paid),total=Number(dashboardData.tuition.total);
  $("payment-progress").style.width=(total>0?Math.min(100,paid/total*100):0)+"%";
  $("course-list").replaceChildren();
  if(!dashboardData.courses.length) $("course-list").innerHTML='<div class="notice">No courses assigned yet. Contact the academy administrator.</div>';
  dashboardData.courses.forEach(course=>{
    const card=document.createElement("article");card.className="panel";
    const title=document.createElement("h3");title.textContent=course.title;
    const desc=document.createElement("p");desc.className="muted";desc.textContent=course.description;
    const bar=document.createElement("div");bar.className="progress";
    const fill=document.createElement("span");fill.style.width=course.progress+"%";bar.append(fill);
    const prog=document.createElement("p");prog.className="muted";prog.textContent=`${course.progress}% complete · ${course.status}`;
    card.append(title,desc,bar,prog);$("course-list").append(card);
  });
  $("invoice-list").replaceChildren();
  if(!dashboardData.tuition.invoices.length) $("invoice-list").innerHTML='<div class="notice">No invoices are available for this account yet.</div>';
  dashboardData.tuition.invoices.forEach(invoice=>{
    const row=document.createElement("div");row.className="panel";row.style.marginTop="12px";
    const title=document.createElement("h3");title.textContent=invoice.description;
    const details=document.createElement("p");details.className="muted";details.textContent=`Total ${money(invoice.total)} · Paid ${money(invoice.paid)} · Balance ${money(invoice.balance)} · ${invoice.status}`;
    row.append(title,details);
    if(Number(invoice.balance)>0){
      const btn=document.createElement("button");btn.className="paypal";btn.textContent="Pay this invoice with PayPal";
      btn.addEventListener("click",()=>startPaypal(invoice));row.append(btn);
    }
    $("invoice-list").append(row);
  });
  $("payments-list").replaceChildren();
  if(!dashboardData.payments.length) $("payments-list").innerHTML='<p class="muted">No completed payments recorded yet.</p>';
  dashboardData.payments.forEach(p=>{
    const row=document.createElement("p");row.textContent=`${money(p.amount)} ${p.currency} · ${new Date(p.createdAt).toLocaleString()} · ${p.status}`;$("payments-list").append(row);
  });
}
function tab(name){
  ["overview","courses","tuition"].forEach(n=>$("tab-"+n).classList.toggle("hidden",n!==name));
  document.querySelectorAll("[data-tab]").forEach(b=>b.classList.toggle("active",b.dataset.tab===name));
}
async function startPaypal(invoice){
  const messageEl=$("payment-message");messageEl.className="notice";messageEl.textContent="Preparing secure PayPal checkout…";
  try {
    const amount=Number($("payment-amount").value);
    const body={invoiceId:invoice.id};
    if(Number.isFinite(amount)&&amount>0&&amount<Number(invoice.balance)) body.amount=amount;
    const order=await api("/api/payments/paypal/create-order",{method:"POST",body:JSON.stringify(body)});
    const sdk=await loadPaypalSdk();
    $("paypal-buttons").replaceChildren();
    await sdk.Buttons({
      createOrder:()=>order.orderId,
      onApprove:async(data)=>{
        messageEl.textContent="Verifying payment with PayPal…";
        try{
          await api("/api/payments/paypal/capture-order",{method:"POST",body:JSON.stringify({orderId:data.orderID})});
          messageEl.className="success";messageEl.textContent="Payment completed and verified.";
          await loadDashboard();
        }catch(err){messageEl.className="error";messageEl.textContent=err.message;}
      },
      onCancel:()=>{messageEl.textContent="Payment cancelled. No payment was recorded as completed.";},
      onError:err=>{console.error(err);messageEl.className="error";messageEl.textContent="PayPal checkout encountered an error. Please try again.";}
    }).render("#paypal-buttons");
    messageEl.textContent="Complete payment using the PayPal buttons below.";
  }catch(err){messageEl.className="error";messageEl.textContent=err.message;}
}
function loadPaypalSdk(){
  if(paypalSdkPromise)return paypalSdkPromise;
  paypalSdkPromise=api("/api/config/paypal").then(({clientId,currency})=>{
    if(!clientId)throw new Error("PayPal is not configured yet. Ask the administrator to add PayPal credentials.");
    return new Promise((resolve,reject)=>{
      const script=document.createElement("script");
      script.src=`https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture`;
      script.onload=()=>window.paypal?resolve(window.paypal):reject(new Error("PayPal SDK failed to load."));
      script.onerror=()=>reject(new Error("Could not load PayPal. Check your connection and configuration."));
      document.head.append(script);
    });
  });
  return paypalSdkPromise;
}
document.querySelectorAll("[data-login]").forEach(b=>b.addEventListener("click",()=>show("login-view")));
$("back-home").addEventListener("click",()=>show("public-view"));
$("explore").addEventListener("click",()=>$("programs").scrollIntoView({behavior:"smooth"}));
$("login-form").addEventListener("submit",login);
$("logout").addEventListener("click",logout);
document.querySelectorAll("[data-tab]").forEach(b=>b.addEventListener("click",()=>tab(b.dataset.tab)));
document.querySelectorAll(".open-courses").forEach(b=>b.addEventListener("click",()=>tab("courses")));
document.querySelectorAll(".open-tuition").forEach(b=>b.addEventListener("click",()=>tab("tuition")));
$("refresh-dashboard").addEventListener("click",async()=>{try{await loadDashboard();message("dashboard-message","Dashboard refreshed.");}catch(e){message("dashboard-message",e.message,true);}});
$("paypal-start").addEventListener("click",async()=>{
  if(!dashboardData?.tuition?.invoices?.length){message("payment-message","No invoice exists for your account. Contact the academy administrator.",true);return;}
  const invoice=dashboardData.tuition.invoices.find(i=>Number(i.balance)>0);
  if(!invoice){message("payment-message","There is no outstanding invoice to pay.");return;}
  await startPaypal(invoice);
});
api("/api/auth/me").then(async()=>{await loadDashboard();show("dashboard-view")}).catch(()=>show("public-view"));
