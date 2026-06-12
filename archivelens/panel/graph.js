export function renderGraph(containerId, graphData, onNodeClick) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  const width = container.clientWidth || 1200;
  const height = container.clientHeight || 700;

  const svg = d3
    .select(container)
    .append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", [0, 0, width, height]);

  const rootGroup = svg.append("g");

  const zoom = d3.zoom().scaleExtent([0.2, 5]).on("zoom", (event) => {
    rootGroup.attr("transform", event.transform);
  });
  svg.call(zoom);

  const link = rootGroup
    .append("g")
    .attr("stroke", "#8aa39a")
    .attr("stroke-opacity", 0.85)
    .selectAll("line")
    .data(graphData.links)
    .join("line")
    .attr("stroke-width", (d) => Math.max(1.2, (d.weight || 1) * 2))
    .attr("stroke-dasharray", (d) => {
      if (d.corroborationStatus === "UNCORROBORATED") {
        return "6,4";
      }
      return d.corroborationStatus === "SINGLE-SOURCE" ? "2,3" : "0";
    })
    .attr("stroke-opacity", (d) => (d.corroborationStatus === "SINGLE-SOURCE" ? 0.35 : 0.85));

  const node = rootGroup
    .append("g")
    .selectAll("circle")
    .data(graphData.nodes)
    .join("circle")
    .attr("r", (d) => (d.isRoot ? 16 : 8))
    .attr("fill", (d) => {
      if (d.isRoot) {
        return "#d9623b";
      }
      if (d.consistencyFlag === "DISCREPANCY") {
        return "#b8483a";
      }
      return "#1f6f6c";
    })
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5)
    .style("cursor", "pointer")
    .call(drag(simulation()))
    .on("click", (_, d) => onNodeClick?.(d));

  const label = rootGroup
    .append("g")
    .selectAll("text")
    .data(graphData.nodes)
    .join("text")
    .text((d) => d.label)
    .attr("font-size", 12)
    .attr("dx", 10)
    .attr("dy", 4)
    .attr("fill", "#223d45");

  const simulationRef = simulation();

  simulationRef.nodes(graphData.nodes).on("tick", () => {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    node.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
    label.attr("x", (d) => d.x).attr("y", (d) => d.y);
  });

  simulationRef.force(
    "link",
    d3
      .forceLink(graphData.links)
      .id((d) => d.id)
      .distance((d) => 120 - Math.min(70, (d.weight || 1) * 20))
  );

  function simulation() {
    return d3
      .forceSimulation()
      .force("charge", d3.forceManyBody().strength(-220))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide().radius((d) => (d.isRoot ? 24 : 14)));
  }

  function drag(sim) {
    function started(event, d) {
      if (!event.active) {
        sim.alphaTarget(0.3).restart();
      }
      d.fx = d.x;
      d.fy = d.y;
    }
    function dragged(event, d) {
      d.fx = event.x;
      d.fy = event.y;
    }
    function ended(event, d) {
      if (!event.active) {
        sim.alphaTarget(0);
      }
      d.fx = null;
      d.fy = null;
    }
    return d3.drag().on("start", started).on("drag", dragged).on("end", ended);
  }

  return svg.node();
}

export function graphToPng(svgElement, filename = "archivelens-graph.png") {
  const serializer = new XMLSerializer();
  const source = serializer.serializeToString(svgElement);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const img = new Image();

  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = svgElement.viewBox.baseVal.width;
    canvas.height = svgElement.viewBox.baseVal.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);

    canvas.toBlob((pngBlob) => {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(pngBlob);
      link.download = filename;
      link.click();
    });
  };

  img.src = url;
}
