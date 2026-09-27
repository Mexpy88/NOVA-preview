use fiksi::{System, SolvingOptions, constraints, elements};
use serde::Serialize;
use std::time::Instant;

#[derive(Serialize)]
struct Row {
    requested_distance_constraints: usize,
    points: usize,
    cold_median_ms: f64,
    warm_persistent_median_ms: f64,
    structural_edit_ms: f64,
    warm_iterations: usize,
    rms_residual: f64,
    satisfied: bool,
}

#[derive(Serialize)]
struct Diagnostics {
    underconstrained_solve_finite: bool,
    overconstrained_detected: bool,
}

#[derive(Serialize)]
struct Report {
    candidate: &'static str,
    source_commit: &'static str,
    benchmark_semantics: &'static str,
    rows: Vec<Row>,
    diagnostics: Diagnostics,
}

fn xy(i:usize)->(f64,f64){
    if i==0{return(0.0,0.0)}
    if i==1{return(4.0,0.0)}
    (i as f64*4.0,if i%2==0{3.0}else{-3.0})
}
fn dist(a:(f64,f64),b:(f64,f64))->f64{
    let dx=a.0-b.0;let dy=a.1-b.1;(dx*dx+dy*dy).sqrt()
}
fn median(mut xs:Vec<f64>)->f64{xs.sort_by(|a,b|a.total_cmp(b));xs[xs.len()/2]}
fn rms(s:&System)->f64{
    let vals:Vec<f64>=s.get_constraint_handles().map(|c|c.calculate_residual(s)).collect();
    if vals.is_empty(){return 0.0}
    (vals.iter().map(|v|v*v).sum::<f64>()/vals.len() as f64).sqrt()
}

fn build(k:usize)->(System,Vec<fiksi::ElementHandle<elements::Point>>,Vec<fiksi::ConstraintHandle<constraints::PointPointDistance>>,Vec<f64>){
    let n=k.div_ceil(2)+2;
    let mut s=System::new();
    let mut pts=Vec::with_capacity(n);
    for i in 0..n{
        let (x,y)=xy(i);
        let perturb=if i<2{0.0}else{if i%2==0{0.35}else{-0.27}};
        let p=elements::Point::create(&mut s,x+perturb,y-perturb*0.5);
        if i<2{p.fix(&mut s);}
        pts.push(p);
    }
    let mut hs=Vec::new();let mut targets=Vec::new();
    for i in 2..n{
        if hs.len()<k{
            let d=dist(xy(i),xy(i-1));
            hs.push(constraints::PointPointDistance::create(&mut s,pts[i],pts[i-1],d));targets.push(d);
        }
        if hs.len()<k{
            let d=dist(xy(i),xy(i-2));
            hs.push(constraints::PointPointDistance::create(&mut s,pts[i],pts[i-2],d));targets.push(d);
        }
    }
    (s,pts,hs,targets)
}

fn run_size(k:usize)->Row{
    let reps=if k>=1000{3}else{5};
    let mut cold=Vec::new();
    for _ in 0..reps{
        let (mut s,_,_,_)=build(k);
        let t=Instant::now();s.solve(SolvingOptions::DEFAULT);cold.push(t.elapsed().as_secs_f64()*1000.0);
        assert!(rms(&s)<1e-3,"Fiksi cold residual too high");
    }

    let (mut s,mut pts,hs,targets)=build(k);
    s.solve(SolvingOptions::DEFAULT);
    let mid=hs.len()/2;let base=targets[mid];
    let warm_n=if k>=1000{20}else{50};
    let mut warm=Vec::new();
    for i in 0..warm_n{
        hs[mid].update_parameter(&mut s,base*(if i%2==0{1.001}else{0.999}));
        let t=Instant::now();s.solve(SolvingOptions::DEFAULT);warm.push(t.elapsed().as_secs_f64()*1000.0);
    }
    let rr=rms(&s);

    let i=pts.len();
    let (x,y)=xy(i);
    let p=elements::Point::create(&mut s,x+0.2,y-0.1);
    let d1=dist(xy(i),xy(i-1));let d2=dist(xy(i),xy(i-2));
    constraints::PointPointDistance::create(&mut s,p,pts[i-1],d1);
    constraints::PointPointDistance::create(&mut s,p,pts[i-2],d2);
    pts.push(p);
    let t=Instant::now();s.solve(SolvingOptions::DEFAULT);
    let structural=t.elapsed().as_secs_f64()*1000.0;

    Row{
        requested_distance_constraints:k,points:pts.len(),
        cold_median_ms:median(cold),warm_persistent_median_ms:median(warm),
        structural_edit_ms:structural,warm_iterations:warm_n,
        rms_residual:rr,satisfied:rr<1e-3,
    }
}

fn diagnostics()->Diagnostics{
    let mut s=System::new();
    let a=elements::Point::create(&mut s,0.0,0.0);
    let b=elements::Point::create(&mut s,4.3,0.2);
    constraints::PointPointDistance::create(&mut s,a,b,4.0);
    s.solve(SolvingOptions::DEFAULT);
    let under_finite=rms(&s).is_finite();

    let mut o=System::new();
    let p0=elements::Point::create(&mut o,0.123,0.1);
    let p1=elements::Point::create(&mut o,1.2,0.0);
    let p2=elements::Point::create(&mut o,-0.5,1.1);
    let p3=elements::Point::create(&mut o,1.599,1.2);
    constraints::PointPointDistance::create(&mut o,p0,p1,1.0);
    constraints::PointPointDistance::create(&mut o,p0,p2,1.5);
    constraints::PointPointDistance::create(&mut o,p1,p3,1.7);
    constraints::PointPointDistance::create(&mut o,p2,p3,1.2);
    constraints::PointPointDistance::create(&mut o,p1,p2,2.0);
    constraints::PointPointDistance::create(&mut o,p0,p3,5.0);
    let over=!o.analyze().overconstrained.is_empty();
    Diagnostics{underconstrained_solve_finite:under_finite,overconstrained_detected:over}
}

fn main(){
    let report=Report{
        candidate:"Fiksi",
        source_commit:"ff4850546738fb82e95ff27c4db63e924d938473",
        benchmark_semantics:"cold solve; persistent System warm target updates via ConstraintHandle::update_parameter; structural = add point+constraints to same System",
        rows:[50usize,100,500,2000].into_iter().map(run_size).collect(),
        diagnostics:diagnostics(),
    };
    println!("{}",serde_json::to_string_pretty(&report).unwrap());
}
