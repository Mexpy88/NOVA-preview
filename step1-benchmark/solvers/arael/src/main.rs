use arael::model::CrossBlock;
use arael::refs::Ref;
use arael::vect::vect2d;
use arael_sketch_solver::{Sketch, Point, DistancePP};
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
    end_cost: f64,
    satisfied: bool,
}

#[derive(Serialize)]
struct Diagnostics {
    underconstrained_dof_detected: bool,
    incompatible_fixed_distance_cost_detected: bool,
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

fn build(k:usize)->(Sketch,Vec<Ref<Point>>,Vec<f64>){
    let n=k.div_ceil(2)+2;
    let mut s=Sketch::new();
    let mut pts=Vec::with_capacity(n);
    for i in 0..n{
        let (x,y)=xy(i);
        let perturb=if i<2{0.0}else{if i%2==0{0.35}else{-0.27}};
        let p=if i<2{
            s.add_point_fixed(vect2d::new(x,y))
        }else{
            s.add_point(vect2d::new(x+perturb,y-perturb*0.5))
        };
        pts.push(p);
    }
    let mut targets=Vec::new();
    for i in 2..n{
        if s.distance_pp.len()<k{
            let d=dist(xy(i),xy(i-1));targets.push(d);
            s.distance_pp.push(DistancePP{a:pts[i],b:pts[i-1],distance:d,nid:0,cid:0,hb:CrossBlock::new()});
        }
        if s.distance_pp.len()<k{
            let d=dist(xy(i),xy(i-2));targets.push(d);
            s.distance_pp.push(DistancePP{a:pts[i],b:pts[i-2],distance:d,nid:0,cid:0,hb:CrossBlock::new()});
        }
    }
    (s,pts,targets)
}

fn run_size(k:usize)->Row{
    let reps=if k>=1000{3}else{5};
    let mut cold=Vec::new();
    for _ in 0..reps{
        let (mut s,_,_)=build(k);
        let t=Instant::now();let r=s.solve();cold.push(t.elapsed().as_secs_f64()*1000.0);
        assert!(r.end_cost.is_finite(),"Arael cold cost non-finite");
    }

    let (mut s,mut pts,targets)=build(k);
    let mut r=s.solve();
    let mid=s.distance_pp.len()/2;let base=targets[mid];
    let warm_n=if k>=1000{20}else{50};
    let mut warm=Vec::new();
    for i in 0..warm_n{
        s.distance_pp[mid].distance=base*(if i%2==0{1.001}else{0.999});
        let t=Instant::now();r=s.solve();warm.push(t.elapsed().as_secs_f64()*1000.0);
    }

    let i=pts.len();let (x,y)=xy(i);
    let p=s.add_point(vect2d::new(x+0.2,y-0.1));
    let d1=dist(xy(i),xy(i-1));let d2=dist(xy(i),xy(i-2));
    s.distance_pp.push(DistancePP{a:p,b:pts[i-1],distance:d1,nid:0,cid:0,hb:CrossBlock::new()});
    s.distance_pp.push(DistancePP{a:p,b:pts[i-2],distance:d2,nid:0,cid:0,hb:CrossBlock::new()});
    pts.push(p);
    let t=Instant::now();let structural_result=s.solve();
    let structural=t.elapsed().as_secs_f64()*1000.0;

    Row{
        requested_distance_constraints:k,points:pts.len(),
        cold_median_ms:median(cold),warm_persistent_median_ms:median(warm),
        structural_edit_ms:structural,warm_iterations:warm_n,
        end_cost:r.end_cost,
        satisfied:r.end_cost.is_finite() && structural_result.end_cost.is_finite(),
    }
}

fn diagnostics()->Diagnostics{
    let mut u=Sketch::new();
    let a=u.add_point(vect2d::new(0.0,0.0));
    let b=u.add_point(vect2d::new(4.2,0.2));
    u.distance_pp.push(DistancePP{a,b,distance:4.0,nid:0,cid:0,hb:CrossBlock::new()});
    let _=u.solve();
    let under=u.dof().map(|n|n>0).unwrap_or(false);

    let mut o=Sketch::new();
    let a=o.add_point_fixed(vect2d::new(0.0,0.0));
    let b=o.add_point_fixed(vect2d::new(10.0,0.0));
    o.distance_pp.push(DistancePP{a,b,distance:4.0,nid:0,cid:0,hb:CrossBlock::new()});
    let r=o.solve();
    Diagnostics{
        underconstrained_dof_detected:under,
        incompatible_fixed_distance_cost_detected:r.end_cost.is_finite() && r.end_cost>1e-4,
    }
}

fn main(){
    let report=Report{
        candidate:"Arael",
        source_commit:"dacb51110640ce429fbb4ea87ecad46a2f00600b",
        benchmark_semantics:"cold solve; persistent Sketch warm distance updates; structural = add point+constraints to same Sketch; default features disabled on arael core to avoid optional license-changing paths",
        rows:[50usize,100,500,2000].into_iter().map(run_size).collect(),
        diagnostics:diagnostics(),
    };
    println!("{}",serde_json::to_string_pretty(&report).unwrap());
}
